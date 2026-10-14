const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Result = require('../models/Result');
const Semester = require('../models/Semester');
const Subject = require('../models/Subject');
const { asyncHandler, ApiError } = require('../middlewares/error');

// GET /api/student/dashboard
const dashboard = asyncHandler(async (req, res) => {
  const student = req.user;
  const semesters = await Semester.find({ status: 'active' }).sort({ order: 1, number: 1 });

  const examMatch = { semester: student.semester, status: { $in: ['published', 'active', 'completed'] } };
  const now = new Date();

  const [available, upcoming, completed, attempts, releasedResults] = await Promise.all([
    Exam.find({ ...examMatch, status: { $in: ['published', 'active'] }, startsAt: { $lte: now }, endsAt: { $gte: now } })
      .populate('subject', 'name code')
      .populate('semester', 'title number')
      .sort({ endsAt: 1 }),
    Exam.find({ ...examMatch, startsAt: { $gt: now }, status: { $in: ['published', 'scheduled', 'active'] } })
      .populate('subject', 'name code')
      .populate('semester', 'title number')
      .sort({ startsAt: 1 }),
    Exam.find({ ...examMatch, status: { $in: ['completed'] } })
      .populate('subject', 'name code')
      .populate('semester', 'title number')
      .sort({ endsAt: -1 })
      .limit(10),
    ExamAttempt.find({ student: student._id }).sort({ createdAt: -1 }).limit(20),
    Result.find({ student: student._id, status: 'released' })
      .populate('exam', 'title')
      .populate('subject', 'name code')
      .sort({ releasedAt: -1 })
      .limit(10),
  ]);

  // mark attempts per exam
  const attemptByExam = new Map();
  attempts.forEach((a) => {
    const key = String(a.exam);
    if (!attemptByExam.has(key)) attemptByExam.set(key, []);
    attemptByExam.get(key).push(a);
  });

  const decorate = (list) =>
    list.map((e) => {
      const obj = e.toObject();
      const at = attemptByExam.get(String(e._id)) || [];
      obj.myAttempts = at.length;
      obj.hasInProgress = at.some((a) => a.status === 'in_progress');
      obj.bestResult = null;
      return obj;
    });

  const results = await Result.find({ student: student._id }).select('exam marksObtained maxMarks percentage status').lean();
  const resultByExam = new Map(results.map((r) => [String(r.exam), r]));

  res.json({
    success: true,
    data: {
      student: student.toSafeJSON(),
      semesters,
      available: decorate(available),
      upcoming: decorate(upcoming),
      completed: decorate(completed).map((e) => ({ ...e, result: resultByExam.get(String(e._id)) || null })),
      recentAttempts: attempts,
      releasedResults,
      serverTime: now,
    },
  });
});

// GET /api/student/semesters/:id/exams
const semesterExams = asyncHandler(async (req, res) => {
  const semId = req.params.id;
  const semester = await Semester.findById(semId);
  if (!semester) throw new ApiError(404, 'Semester not found');
  const isOwn = String(req.user.semester || '') === String(semId);
  const filter = { semester: semId, status: { $in: ['published', 'active', 'completed'] } };
  const now = new Date();
  const exams = await Exam.find(filter).populate('subject', 'name code').sort({ startsAt: 1 });

  const attempts = isOwn ? await ExamAttempt.find({ student: req.user._id, exam: { $in: exams.map((e) => e._id) } }) : [];
  const results = isOwn ? await Result.find({ student: req.user._id, exam: { $in: exams.map((e) => e._id) } }) : [];
  const attemptByExam = new Map();
  attempts.forEach((a) => {
    if (!attemptByExam.has(String(a.exam))) attemptByExam.set(String(a.exam), []);
    attemptByExam.get(String(a.exam)).push(a);
  });
  const resultByExam = new Map(results.map((r) => [String(r.exam), r]));

  const items = exams.map((e) => {
    const o = e.toObject();
    const at = attemptByExam.get(String(e._id)) || [];
    o.myAttempts = at.length;
    o.hasInProgress = at.some((a) => a.status === 'in_progress');
    o.inProgressAttemptId = (at.find((a) => a.status === 'in_progress') || {})._id || null;
    o.result = resultByExam.get(String(e._id)) || null;
    o.canAttempt =
      isOwn &&
      ['published', 'active'].includes(e.status) &&
      now >= e.startsAt &&
      now <= e.endsAt &&
      at.length < e.maxAttempts;
    return o;
  });

  const subjects = await Subject.find({ semester: semId, status: 'active' }).sort({ name: 1 });
  res.json({ success: true, data: { semester, subjects, items, authorized: isOwn, serverTime: now } });
});

// GET /api/student/results
const myResults = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const match = { student: req.user._id };
  const [items, total] = await Promise.all([
    Result.find(match)
      .populate('exam', 'title resultsReleased resultRelease')
      .populate('subject', 'name code')
      .populate('semester', 'title number')
      .sort({ submittedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Result.countDocuments(match),
  ]);
  const visible = items.filter((r) => r.exam && (r.exam.resultsReleased || r.status === 'released'));
  res.json({ success: true, data: { items: visible, total, page, limit } });
});

module.exports = { dashboard, semesterExams, myResults };
