const Exam = require('../models/Exam');
const Question = require('../models/Question');
const ExamAttempt = require('../models/ExamAttempt');
const Result = require('../models/Result');
const User = require('../models/User');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');

const TRANSITIONS = {
  draft: ['scheduled', 'published', 'cancelled'],
  scheduled: ['published', 'draft', 'cancelled'],
  published: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['draft'],
};

function canPerm(req, ...perms) {
  return perms.some((p) => hasPermission(req.user, p));
}

// GET /api/exams
const listExams = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.view', 'results.view')) throw new ApiError(403, 'Missing permission: exams.view');
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.semester) filter.semester = req.query.semester;
  if (req.query.subject) filter.subject = req.query.subject;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.title = rx;
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const [items, total] = await Promise.all([
    Exam.find(filter)
      .populate('semester', 'title number')
      .populate('subject', 'name code')
      .sort({ startsAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Exam.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

// GET /api/exams/:id
const getExam = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.view', 'results.view')) throw new ApiError(403, 'Missing permission: exams.view');
  const exam = await Exam.findById(req.params.id)
    .populate('semester', 'title number')
    .populate('subject', 'name code')
    .populate('questions.question', 'statement type options marks correctAnswers status');
  if (!exam) throw new ApiError(404, 'Exam not found');
  res.json({ success: true, data: { exam } });
});

async function validateExamPayload(body, existing = null) {
  const errors = {};
  const title = String(body.title || '').trim();
  if (!title) errors.title = 'Title is required';
  if (!body.semester) errors.semester = 'Semester is required';
  if (!body.subject) errors.subject = 'Subject is required';
  const duration = Number(body.durationMinutes);
  if (!Number.isFinite(duration) || duration < 1) errors.durationMinutes = 'Duration must be at least 1 minute';
  const startsAt = body.startsAt ? new Date(body.startsAt) : null;
  const endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) errors.startsAt = 'Start date/time is required';
  if (!endsAt || Number.isNaN(endsAt.getTime())) errors.endsAt = 'End date/time is required';
  if (startsAt && endsAt && endsAt <= startsAt) errors.endsAt = 'End must be after start';

  let questionRefs = Array.isArray(body.questions) ? body.questions : existing ? existing.questions : [];
  questionRefs = questionRefs
    .map((q) => (typeof q === 'string' || q.constructor?.name === 'ObjectId' ? { question: q, marks: 1 } : q))
    .filter((q) => q && q.question);

  if (!questionRefs.length) errors.questions = 'Select at least one question';

  let totalMarks = 0;
  if (questionRefs.length) {
    const ids = questionRefs.map((q) => q.question);
    const found = await Question.find({ _id: { $in: ids } }).select('_id marks status').lean();
    const foundMap = new Map(found.map((f) => [String(f._id), f]));
    questionRefs.forEach((q) => {
      const f = foundMap.get(String(q.question));
      if (!f) errors.questions = 'One or more questions no longer exist';
      q.marks = Number.isFinite(Number(q.marks)) ? Number(q.marks) : f ? f.marks : 1;
      totalMarks += q.marks;
    });
  }

  return {
    errors,
    data: {
      title,
      description: body.description || '',
      instructions: body.instructions || '',
      semester: body.semester,
      subject: body.subject,
      course: body.course || '',
      questions: questionRefs.map((q, i) => ({ question: q.question, marks: q.marks, order: i })),
      totalMarks,
      questionCount: questionRefs.length,
      durationMinutes: duration,
      startsAt,
      endsAt,
      maxAttempts: Math.max(1, Number(body.maxAttempts ?? 1)),
      negativeMarking: !!body.negativeMarking,
      shuffleQuestions: !!body.shuffleQuestions,
      shuffleOptions: !!body.shuffleOptions,
      resultRelease: ['immediate', 'after_deadline', 'manual'].includes(body.resultRelease)
        ? body.resultRelease
        : 'immediate',
      allowMultipleAttempts: !!body.allowMultipleAttempts,
    },
  };
}

// POST /api/exams
const createExam = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.create')) throw new ApiError(403, 'Missing permission: exams.create');
  const { errors, data } = await validateExamPayload(req.body || {});
  if (Object.keys(errors).length) throw new ApiError(400, 'Validation failed', errors);
  const exam = await Exam.create({ ...data, status: 'draft', createdBy: req.user._id });
  await audit(req, 'exam.create', 'Exam', exam._id, `created exam "${exam.title}"`);
  res.status(201).json({ success: true, data: { exam } });
});

// PUT /api/exams/:id
const updateExam = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.create', 'exams.schedule')) throw new ApiError(403, 'Missing permission: exams.create');
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (['completed', 'cancelled'].includes(exam.status)) {
    throw new ApiError(409, `A ${exam.status} exam cannot be edited`);
  }
  const activeAttempts = await ExamAttempt.countDocuments({ exam: exam._id, status: 'in_progress' });
  const submitted = await Result.countDocuments({ exam: exam._id });
  if ((activeAttempts || submitted) && req.body.questions) {
    throw new ApiError(409, 'Questions cannot be changed after attempts exist', { activeAttempts, submitted });
  }
  const { errors, data } = await validateExamPayload(req.body, exam);
  if (Object.keys(errors).length) throw new ApiError(400, 'Validation failed', errors);
  Object.assign(exam, data);
  await exam.save();
  await audit(req, 'exam.update', 'Exam', exam._id, `updated exam "${exam.title}"`);
  res.json({ success: true, data: { exam } });
});

// POST /api/exams/:id/status  { status }
const setStatus = asyncHandler(async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new ApiError(404, 'Exam not found');
  const { status } = req.body || {};
  if (!status) throw new ApiError(400, 'status is required');
  const allowed = TRANSITIONS[exam.status] || [];
  if (!allowed.includes(status)) {
    throw new ApiError(409, `Cannot change status from "${exam.status}" to "${status}"`, { allowed });
  }
  if (['published', 'active'].includes(status) && !canPerm(req, 'exams.publish')) {
    throw new ApiError(403, 'Missing permission: exams.publish');
  }
  if (['scheduled'].includes(status) && !canPerm(req, 'exams.schedule', 'exams.create')) {
    throw new ApiError(403, 'Missing permission: exams.schedule');
  }
  if (['draft', 'scheduled'].includes(status) && !canPerm(req, 'exams.create', 'exams.schedule')) {
    throw new ApiError(403, 'Missing permission: exams.create');
  }
  exam.status = status;
  await exam.save();
  await audit(req, 'exam.status', 'Exam', exam._id, `status -> ${status} for "${exam.title}"`);
  res.json({ success: true, data: { exam } });
});

// POST /api/exams/:id/release-results  { release: true|false }
const releaseResults = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.publish')) throw new ApiError(403, 'Missing permission: exams.publish');
  const exam = await Exam.findById(req.params.id);
  if (!exam) throw new ApiError(404, 'Exam not found');
  const release = !!(req.body && req.body.release);
  exam.resultsReleased = release;
  if (release) {
    exam.resultRelease = 'immediate';
    await Result.updateMany({ exam: exam._id, status: { $in: ['evaluated', 'pending'] } }, { status: 'released', releasedAt: new Date() });
  }
  await exam.save();
  await audit(req, 'exam.release_results', 'Exam', exam._id, `${release ? 'released' : 'hid'} results for "${exam.title}"`);
  res.json({ success: true, data: { exam } });
});

// GET /api/exams/:id/monitor
const monitor = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.monitor', 'exams.view')) throw new ApiError(403, 'Missing permission: exams.monitor');
  const exam = await Exam.findById(req.params.id).populate('semester subject', 'title number name');
  if (!exam) throw new ApiError(404, 'Exam not found');
  const now = new Date();
  const registered = await User.countDocuments({ role: 'student', semester: exam.semester._id, status: 'active' });
  const [statusCounts, startedAgg] = await Promise.all([
    ExamAttempt.aggregate([
      { $match: { exam: exam._id } },
      { $group: { _id: '$status', count: { $sum: 1 }, latest: { $max: '$updatedAt' } } },
    ]),
    ExamAttempt.find({ exam: exam._id })
      .populate('student', 'name studentId rollNumber email')
      .sort({ updatedAt: -1 })
      .limit(100)
      .select('student status startedAt submittedAt deadline updatedAt answeredCount attemptNumber'),
  ]);
  const counts = Object.fromEntries(statusCounts.map((c) => [c._id, c.count]));
  const resultsCount = await Result.countDocuments({ exam: exam._id });
  res.json({
    success: true,
    data: {
      exam,
      serverTime: now,
      registered,
      counts: {
        in_progress: counts.in_progress || 0,
        submitted: counts.submitted || 0,
        expired: counts.expired || 0,
        auto_submitted: counts.auto_submitted || 0,
        totalAttempts: statusCounts.reduce((s, c) => s + c.count, 0),
        started: (counts.in_progress || 0) + (counts.submitted || 0) + (counts.expired || 0) + (counts.auto_submitted || 0),
      },
      results: resultsCount,
      recent: startedAgg,
    },
  });
});

// GET /api/exams/:id/attempts — admin list of attempts with results
const listAttempts = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.monitor', 'results.view')) throw new ApiError(403, 'Missing permission: results.view');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const match = { exam: require('mongoose').Types.ObjectId.createFromHexString(req.params.id) };
  const [items, total] = await Promise.all([
    ExamAttempt.find(match)
      .populate('student', 'name studentId rollNumber email')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ExamAttempt.countDocuments(match),
  ]);
  const results = await Result.find({ exam: req.params.id }).select('attempt marksObtained maxMarks percentage correct incorrect unanswered status').lean();
  const resultMap = new Map(results.map((r) => [String(r.attempt), r]));
  res.json({
    success: true,
    data: {
      items: items.map((a) => ({ ...a.toObject(), result: resultMap.get(String(a._id)) || null })),
      total,
      page,
      limit,
    },
  });
});

// GET /api/exams/preview-questions?semester=&subject=&search=&exclude=
const previewQuestions = asyncHandler(async (req, res) => {
  if (!canPerm(req, 'exams.create', 'exams.schedule')) throw new ApiError(403, 'Missing permission: exams.create');
  const filter = { status: 'published' };
  if (req.query.semester) filter.semester = req.query.semester;
  if (req.query.subject) filter.subject = req.query.subject;
  if (req.query.search) {
    filter.statement = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const [items, total] = await Promise.all([
    Question.find(filter).select('statement type marks difficulty topic options correctAnswers').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Question.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

module.exports = { listExams, getExam, createExam, updateExam, setStatus, releaseResults, monitor, listAttempts, previewQuestions };
