const crypto = require('crypto');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const ExamAttempt = require('../models/ExamAttempt');
const Result = require('../models/Result');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { isResultReleased } = require('../utils/releasePolicy');

/**
 * CBT engine rules:
 *  - Backend is the authority for start time, deadline and submission eligibility.
 *  - answers are keyed by questionId; updates are idempotent ($set per question).
 *  - finalization (scoring) happens exactly once via an atomic status transition.
 */

function shuffled(arr, seed) {
  const a = arr.slice();
  let s = typeof seed === 'number' ? seed : parseInt(String(seed).slice(0, 8), 16) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadAttemptWithExam(attemptId, user) {
  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) throw new ApiError(404, 'Attempt not found');
  if (String(attempt.student) !== String(user._id) && user.role === 'student') {
    throw new ApiError(403, 'This attempt does not belong to you');
  }
  const exam = await Exam.findById(attempt.exam).populate('semester subject', 'title number name');
  if (!exam) throw new ApiError(404, 'Exam not found');
  return { attempt, exam };
}

function answersMap(attempt) {
  return attempt.answers && typeof attempt.answers === 'object' ? attempt.answers : {};
}


function countAnswered(attempt, questionIds) {
  const map = answersMap(attempt);
  let n = 0;
  questionIds.forEach((id) => {
    const a = map[String(id)];
    if (a && Array.isArray(a.selected) && a.selected.length) n += 1;
  });
  return n;
}

// Server-side deadline enforcement: finalize if past deadline.
async function ensureDeadline(attempt, exam, { auto = true } = {}) {
  if (!attempt.deadline) return attempt;
  const now = new Date();
  if (now > attempt.deadline && ['in_progress'].includes(attempt.status)) {
    if (auto) return finalizeAttempt(attempt, exam, 'expired');
  }
  return attempt;
}

/**
 * Atomic finalization. Only the first caller wins the status transition;
 * scoring runs only for the winner. Safe against timeout + manual submit race.
 */
async function finalizeAttempt(attempt, exam, reason = 'submitted') {
  const now = new Date();
  const won = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    {
      $set: {
        status: reason === 'submitted' ? 'submitted' : reason === 'timeout' ? 'auto_submitted' : 'expired',
        submittedAt: attempt.submittedAt || now,
        finalizedAt: now,
      },
    },
    { returnDocument: 'after' }
  );
  if (!won) {
    // already finalized — return current state
    return { attempt: await ExamAttempt.findById(attempt._id), alreadyFinalized: true };
  }
  const { result } = await scoreAttempt(won, exam, reason);
  return { attempt: won, result, alreadyFinalized: false };
}

async function scoreAttempt(attempt, exam, reason) {
  const existing = await Result.findOne({ attempt: attempt._id });
  if (existing) return { result: existing, reused: true };

  const questionIds = attempt.questionOrder.length ? attempt.questionOrder : exam.questions.map((q) => String(q.question));
  const questions = await Question.find({ _id: { $in: questionIds } }).lean();
  const qMap = new Map(questions.map((q) => [String(q._id), q]));
  const marksMap = new Map(exam.questions.map((q) => [String(q.question), q.marks]));

  const map = answersMap(attempt);
  const evaluation = [];
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let marksObtained = 0;
  let maxMarks = 0;

  questionIds.forEach((qid) => {
    const q = qMap.get(String(qid));
    if (!q) return;
    const examQ = marksMap.get(String(qid));
    const marks = typeof examQ === 'number' ? examQ : q.marks;
    maxMarks += marks;
    const given = (map[String(qid)] && map[String(qid)].selected) || [];
    const answerSet = new Set((q.correctAnswers || []).map((a) => String(a).toLowerCase()));
    const givenSet = new Set(given.map((a) => String(a).toLowerCase()));

    let isCorrect = false;
    if (givenSet.size && answerSet.size) {
      if (q.type === 'msq') {
        isCorrect =
          givenSet.size === answerSet.size && [...answerSet].every((a) => givenSet.has(a));
      } else {
        isCorrect = givenSet.has([...answerSet][0]) && givenSet.size === 1;
      }
    }

    let awarded = 0;
    if (!givenSet.size) {
      unanswered += 1;
    } else if (isCorrect) {
      correct += 1;
      awarded = marks;
    } else {
      incorrect += 1;
      if (exam.negativeMarking) awarded = -(q.negativeMarks || 0);
    }
    marksObtained += awarded;
    evaluation.push({
      question: qid,
      selected: [...givenSet],
      correct: [...answerSet],
      isCorrect,
      awarded,
    });
  });

  marksObtained = Math.round(marksObtained * 100) / 100;
  const percentage = maxMarks ? Math.round((marksObtained / maxMarks) * 10000) / 100 : 0;

  const result = await Result.create({
    exam: exam._id,
    attempt: attempt._id,
    student: attempt.student,
    semester: exam.semester ? exam.semester._id || exam.semester : null,
    subject: exam.subject ? exam.subject._id || exam.subject : null,
    status: isResultReleased(exam) ? 'released' : 'evaluated',
    totalQuestions: questionIds.length,
    correct,
    incorrect,
    unanswered,
    marksObtained,
    maxMarks,
    percentage,
    passStatus: 'none',
    evaluation,
    submittedAt: attempt.submittedAt || new Date(),
    evaluatedAt: new Date(),
    releasedAt: isResultReleased(exam) ? new Date() : null,
  });
  return { result };
}

// GET /api/exam-attempts/mine?exam=
const myAttempts = asyncHandler(async (req, res) => {
  const filter = { student: req.user._id };
  if (req.query.exam) filter.exam = req.query.exam;
  const attempts = await ExamAttempt.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: { items: attempts } });
});

// POST /api/exam-attempts/start  { examId }
const startAttempt = asyncHandler(async (req, res) => {
  const { examId } = req.validated || req.body;
  const exam = await Exam.findById(examId).populate('semester subject', 'title number name');
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (req.user.role === 'student') {
    if (String(exam.semester?._id || exam.semester) !== String(req.user.semester || '')) {
      throw new ApiError(403, 'You are not authorized for this examination');
    }
    if (req.user.status !== 'active') throw new ApiError(403, 'Account inactive');
  }
  if (!['published', 'active'].includes(exam.status)) {
    throw new ApiError(403, 'This examination is not available', { status: exam.status });
  }
  const now = new Date();
  if (now < exam.startsAt) throw new ApiError(403, 'This examination has not started yet', { startsAt: exam.startsAt });
  if (now > exam.endsAt) throw new ApiError(403, 'This examination is closed', { endsAt: exam.endsAt });

  const existing = await ExamAttempt.find({ exam: exam._id, student: req.user._id }).sort({ attemptNumber: -1 });

  // Resume an in-progress attempt (refresh / network interruption recovery)
  const inProgress = existing.find((a) => a.status === 'in_progress');
  if (inProgress) {
    const refreshed = await ensureDeadline(inProgress, exam);
    if (refreshed.status === 'in_progress') {
      return res.json({ success: true, data: { attempt: refreshed, resumed: true, serverTime: new Date() } });
    }
    // it expired while away — fall through to check attempts left
  }

  if (existing.length >= exam.maxAttempts) {
    throw new ApiError(409, 'Maximum attempts reached', { attempts: existing.length, maxAttempts: exam.maxAttempts });
  }

  const attemptNumber = existing.length + 1;
  const seed = crypto.randomBytes(4).toString('hex');
  let questionIds = exam.questions.map((q) => String(q.question));
  if (exam.shuffleQuestions) questionIds = shuffled(questionIds, seed);

  const optionOrder = {};
  if (exam.shuffleOptions) {
    const qs = await Question.find({ _id: { $in: questionIds } }).select('options').lean();
    qs.forEach((q) => {
      optionOrder[String(q._id)] = shuffled(q.options.map((o) => o.key), seed + String(q._id));
    });
  }

  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + exam.durationMinutes * 60 * 1000);

  const attempt = await ExamAttempt.create({
    exam: exam._id,
    student: req.user._id,
    attemptNumber,
    status: 'in_progress',
    startedAt,
    deadline,
    questionOrder: questionIds,
    optionOrder,
    answers: {},
    ip: req.ip || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 250),
  });

  await audit(req, 'attempt.start', 'ExamAttempt', attempt._id, `started exam "${exam.title}" attempt #${attemptNumber}`);
  res.status(201).json({ success: true, data: { attempt, resumed: false, serverTime: startedAt } });
});

// GET /api/exam-attempts/:id — full paper (no correct answers for students)
const getAttempt = asyncHandler(async (req, res) => {
  let { attempt, exam } = await loadAttemptWithExam(req.params.id, req.user);
  attempt = await ensureDeadline(attempt, exam);

  const isAdmin = req.user.role !== 'student';
  if (!isAdmin && String(attempt.student) !== String(req.user._id)) {
    throw new ApiError(403, 'This attempt does not belong to you');
  }

  const qids = attempt.questionOrder.length ? attempt.questionOrder : exam.questions.map((q) => q.question);
  const questions = await Question.find({ _id: { $in: qids } })
    .select('statement type options marks negativeMarks topic difficulty correctAnswers explanation')
    .lean();
  const orderIndex = new Map(qids.map((id, i) => [String(id), i]));
  questions.sort((a, b) => orderIndex.get(String(a._id)) - orderIndex.get(String(b._id)));

  // Strip correct answers for students unless results are released and attempt finalized
  const finalized = attempt.status !== 'in_progress';
  const showAnswers = finalized && (isAdmin || isResultReleased(exam));
  const safeQuestions = questions.map((q) => {
    const base = {
      _id: q._id,
      statement: q.statement,
      type: q.type,
      marks: (exam.questions.find((e) => String(e.question) === String(q._id)) || {}).marks ?? q.marks,
      topic: q.topic,
      difficulty: q.difficulty,
      options:
        attempt.optionOrder && attempt.optionOrder[String(q._id)]
          ? attempt.optionOrder[String(q._id)].map((k) => q.options.find((o) => o.key === k)).filter(Boolean)
          : q.options,
    };
    if (showAnswers) {
      base.correctAnswers = q.correctAnswers;
      base.explanation = q.explanation;
    }
    return base;
  });

  const now = new Date();
  const remainingMs = attempt.deadline ? Math.max(0, new Date(attempt.deadline) - now) : 0;

  res.json({
    success: true,
    data: {
      attempt: {
        _id: attempt._id,
        exam: exam._id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        deadline: attempt.deadline,
        submittedAt: attempt.submittedAt,
        answers: answersMap(attempt),
        attemptNumber: attempt.attemptNumber,
        answeredCount: attempt.answeredCount,
      },
      exam: {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        instructions: exam.instructions,
        durationMinutes: exam.durationMinutes,
        totalMarks: exam.totalMarks,
        questionCount: exam.questionCount,
        shuffleQuestions: exam.shuffleQuestions,
        negativeMarking: exam.negativeMarking,
        resultsReleased: exam.resultsReleased,
        semester: exam.semester,
        subject: exam.subject,
        endsAt: exam.endsAt,
      },
      questions: safeQuestions,
      serverTime: now,
      remainingMs,
      showAnswers,
    },
  });
});

// PUT /api/exam-attempts/:id/answers  { questionId, selected: [], markedForReview?, visited? }
const saveAnswer = asyncHandler(async (req, res) => {
  let { attempt, exam } = await loadAttemptWithExam(req.params.id, req.user);
  if (String(attempt.student) !== String(req.user._id)) throw new ApiError(403, 'Not your attempt');
  if (attempt.status !== 'in_progress') {
    throw new ApiError(409, 'Attempt is already finalized', { status: attempt.status });
  }
  if (attempt.deadline && new Date() > attempt.deadline) {
    await finalizeAttempt(attempt, exam, 'timeout');
    throw new ApiError(410, 'Time is up. Your attempt has been submitted.', { deadline: attempt.deadline });
  }

  const { questionId, selected, markedForReview, visited } = req.body || {};
  if (!questionId) throw new ApiError(400, 'questionId is required');
  const qid = String(questionId);
  if (!attempt.questionOrder.map(String).includes(qid)) throw new ApiError(400, 'Question not in this attempt');

  const allowedKeys = await Question.findById(qid).select('options type').lean();
  if (!allowedKeys) throw new ApiError(404, 'Question not found');
  const validKeys = new Set(allowedKeys.options.map((o) => o.key).concat(['true', 'false']));
  const cleanSelected = (Array.isArray(selected) ? selected : [])
    .map((s) => String(s).toLowerCase())
    .filter((s) => validKeys.has(s));
  if (Array.isArray(selected) && selected.length && !cleanSelected.length) {
    throw new ApiError(400, 'Invalid option value');
  }
  if (allowedKeys.type === 'mcq' && cleanSelected.length > 1) cleanSelected.splice(1);

  const update = {};
  update[`answers.${qid}.selected`] = cleanSelected;
  update[`answers.${qid}.updatedAt`] = new Date();
  if (markedForReview !== undefined) update[`answers.${qid}.markedForReview`] = !!markedForReview;
  if (visited !== undefined) update[`answers.${qid}.visited`] = !!visited;
  update.$inc = { clientRevision: 1 };

  const updated = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    update,
    { returnDocument: 'after' }
  );
  if (!updated) throw new ApiError(409, 'Attempt is already finalized');

  const answered = countAnswered(updated, updated.questionOrder);
  await ExamAttempt.updateOne({ _id: updated._id }, { $set: { answeredCount: answered } });

  res.json({
    success: true,
    data: {
      saved: true,
      answeredCount: answered,
      revision: updated.clientRevision,
      serverTime: new Date(),
      remainingMs: Math.max(0, new Date(updated.deadline) - new Date()),
    },
  });
});

// POST /api/exam-attempts/:id/submit
const submitAttempt = asyncHandler(async (req, res) => {
  let { attempt, exam } = await loadAttemptWithExam(req.params.id, req.user);
  if (String(attempt.student) !== String(req.user._id)) throw new ApiError(403, 'Not your attempt');

  if (attempt.status !== 'in_progress') {
    // idempotent: repeated submit returns existing result (no duplicate results)
    const existing = await Result.findOne({ attempt: attempt._id });
    return res.json({
      success: true,
      data: { alreadySubmitted: true, attempt, result: existing, serverTime: new Date() },
    });
  }

  const now = new Date();
  const timedOut = attempt.deadline && now > attempt.deadline;
  const { attempt: finalAttempt, result, alreadyFinalized } = await finalizeAttempt(
    attempt,
    exam,
    timedOut ? 'timeout' : 'submitted'
  );

  await audit(req, 'attempt.submit', 'ExamAttempt', finalAttempt._id, `submitted exam "${exam.title}"${timedOut ? ' (deadline)' : ''}`);
  res.json({
    success: true,
    data: {
      alreadySubmitted: alreadyFinalized,
      attempt: finalAttempt,
      result: req.user.role !== 'student' || isResultReleased(exam, finalAttempt) ? result : null,
      resultPending: !(req.user.role !== 'student' || isResultReleased(exam, finalAttempt)),
      serverTime: now,
    },
  });
});

// GET /api/exam-attempts/:id/result
const attemptResult = asyncHandler(async (req, res) => {
  const { attempt, exam } = await loadAttemptWithExam(req.params.id, req.user);
  const isOwner = String(attempt.student) === String(req.user._id);
  const isAdmin = req.user.role !== 'student';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'Not authorized');

  const result = await Result.findOne({ attempt: attempt._id }).populate('attempt', 'status startedAt submittedAt deadline attemptNumber');
  if (!result) throw new ApiError(404, 'Result not yet available');

  if (req.user.role === 'student') {
    if (!isResultReleased(exam, attempt)) {
      throw new ApiError(403, 'Result has not been released yet');
    }
  }

  // Strip correct answers/explanations when not released
  const canSeeAnswers = isAdmin || isResultReleased(exam, attempt);
  const evaluation = canSeeAnswers
    ? result.evaluation
    : result.evaluation.map((e) => ({ question: e.question, selected: e.selected, awarded: e.awarded, isCorrect: e.isCorrect }));

  const safeResult = { ...result.toObject(), evaluation };
  if (req.user.role === 'student') delete safeResult.manualAdjustments;

  res.json({ success: true, data: { result: safeResult, exam, canSeeAnswers } });
});

// background auto-finalizer
async function autoFinalizeExpired() {
  const now = new Date();
  const expired = await ExamAttempt.find({ status: 'in_progress', deadline: { $lt: now } }).limit(500);
  let n = 0;
  for (const a of expired) {
    try {
      const exam = await Exam.findById(a.exam);
      if (!exam) {
        await ExamAttempt.updateOne({ _id: a._id, status: 'in_progress' }, { $set: { status: 'expired', finalizedAt: new Date() } });
        continue;
      }
      const r = await finalizeAttempt(a, exam, 'timeout');
      if (!r.alreadyFinalized) n += 1;
    } catch (e) {
      console.error('[auto-finalize]', e.message);
    }
  }
  if (n) console.log(`[auto-finalize] finalized ${n} expired attempt(s)`);
  return n;
}

module.exports = {
  myAttempts,
  startAttempt,
  getAttempt,
  saveAnswer,
  submitAttempt,
  attemptResult,
  autoFinalizeExpired,
  finalizeAttempt,
};
