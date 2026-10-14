const Result = require('../models/Result');
const Exam = require('../models/Exam');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');
const { isResultReleased } = require('../utils/releasePolicy');

function buildResultFilter(query, user) {
  const filter = {};
  if (user.role === 'student') filter.student = user._id;
  if (query.exam) filter.exam = query.exam;
  if (query.semester) filter.semester = query.semester;
  if (query.subject) filter.subject = query.subject;
  if (query.student) filter.student = query.student;
  if (query.status) filter.status = query.status;
  if (query.passStatus) filter.passStatus = query.passStatus;
  if (query.minScore !== undefined && query.minScore !== '') filter.percentage = { ...filter.percentage, $gte: Number(query.minScore) };
  if (query.maxScore !== undefined && query.maxScore !== '') filter.percentage = { ...filter.percentage, $lte: Number(query.maxScore) };
  if (query.from || query.to) {
    filter.submittedAt = {};
    if (query.from) filter.submittedAt.$gte = new Date(query.from);
    if (query.to) filter.submittedAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
  }
  if (query.search && user.role !== 'student') {
    // search by student identity via $lookup is done in aggregation for admin
    filter.$text = undefined;
    delete filter.$text;
  }
  return filter;
}

// GET /api/results
const listResults = asyncHandler(async (req, res) => {
  const isStudent = req.user.role === 'student';
  if (!isStudent && !hasPermission(req.user, 'results.view')) {
    throw new ApiError(403, 'Missing permission: results.view');
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = buildResultFilter(req.query, req.user);

  const pipeline = [{ $match: filter }];
  if (!isStudent) {
    pipeline.push(
      { $lookup: { from: 'users', localField: 'student', foreignField: '_id', as: 'studentDoc' } },
      { $unwind: { path: '$studentDoc', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'exams', localField: 'exam', foreignField: '_id', as: 'examDoc' } },
      { $unwind: { path: '$examDoc', preserveNullAndEmptyArrays: true } }
    );
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'studentDoc.name': rx },
            { 'studentDoc.studentId': rx },
            { 'studentDoc.rollNumber': rx },
            { 'examDoc.title': rx },
          ],
        },
      });
    }
  } else {
    pipeline.push(
      { $lookup: { from: 'exams', localField: 'exam', foreignField: '_id', as: 'examDoc' } },
      { $unwind: { path: '$examDoc', preserveNullAndEmptyArrays: true } }
    );
    pipeline.push({
      $match: {
        $or: [
          { 'examDoc.resultsReleased': true },
          { 'examDoc.resultRelease': 'immediate' },
          { status: 'released' },
        ],
      },
    });
  }

  const countPipeline = [...pipeline, { $count: 'total' }];
  pipeline.push(
    { $sort: { submittedAt: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
    {
      $project: {
        evaluation: 0,
        manualAdjustments: 0,
        studentDoc: { _id: 1, name: 1, studentId: 1, rollNumber: 1, email: 1, course: 1 },
        examDoc: { _id: 1, title: 1, durationMinutes: 1, resultsReleased: 1, resultRelease: 1 },
      },
    }
  );

  const [items, countRes] = await Promise.all([
    Result.aggregate(pipeline),
    Result.aggregate(countPipeline),
  ]);
  res.json({ success: true, data: { items, total: countRes[0] ? countRes[0].total : 0, page, limit } });
});

// GET /api/results/:id
const getResult = asyncHandler(async (req, res) => {
  const isStudent = req.user.role === 'student';
  if (!isStudent && !hasPermission(req.user, 'results.view')) {
    throw new ApiError(403, 'Missing permission: results.view');
  }
  const result = await Result.findById(req.params.id)
    .populate('student', 'name email studentId rollNumber course phone')
    .populate('exam', 'title durationMinutes totalMarks resultsReleased resultRelease semester subject startsAt endsAt')
    .populate('semester', 'title number')
    .populate('subject', 'name code')
    .populate('attempt', 'startedAt submittedAt deadline status attemptNumber');
  if (!result) throw new ApiError(404, 'Result not found');
  if (isStudent && String(result.student._id) !== String(req.user._id)) {
    throw new ApiError(403, 'You cannot view another student\'s result');
  }

  const exam = result.exam;
  const released = !isStudent || isResultReleased(exam, result.attempt) || result.status === 'released';
  if (isStudent && !released) throw new ApiError(403, 'Result has not been released yet');

  const canSeeAnswers = !isStudent || released;
  const obj = result.toObject();
  if (!canSeeAnswers) {
    obj.evaluation = (obj.evaluation || []).map((e) => ({
      question: e.question,
      selected: e.selected,
      awarded: e.awarded,
      isCorrect: e.isCorrect,
    }));
  }
  if (isStudent) delete obj.manualAdjustments;
  res.json({ success: true, data: { result: obj, canSeeAnswers, released } });
});

// PATCH /api/results/:id/adjust  { delta, reason }
const adjustResult = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'results.grade')) throw new ApiError(403, 'Missing permission: results.grade');
  const { delta, reason } = req.body || {};
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) throw new ApiError(400, 'delta must be a non-zero number');
  if (!reason || !String(reason).trim()) throw new ApiError(400, 'reason is required');
  const result = await Result.findById(req.params.id);
  if (!result) throw new ApiError(404, 'Result not found');
  const previous = result.marksObtained;
  const next = Math.max(0, Math.min(result.maxMarks, previous + d));
  result.marksObtained = next;
  result.percentage = result.maxMarks ? Math.round((next / result.maxMarks) * 10000) / 100 : 0;
  result.manualAdjustments.push({
    by: req.user._id,
    at: new Date(),
    reason: String(reason).trim(),
    delta: d,
    previousMarks: previous,
    newMarks: next,
  });
  await result.save();
  await audit(req, 'result.adjust', 'Result', result._id, `marks ${previous} -> ${next}: ${reason}`);
  res.json({ success: true, data: { result } });
});

// POST /api/results/:id/release  { release }
const releaseResult = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'results.view')) throw new ApiError(403, 'Missing permission: results.view');
  const release = !!(req.body && req.body.release);
  const result = await Result.findById(req.params.id);
  if (!result) throw new ApiError(404, 'Result not found');
  result.status = release ? 'released' : 'evaluated';
  result.releasedAt = release ? new Date() : null;
  await result.save();
  await audit(req, 'result.release', 'Result', result._id, `${release ? 'released' : 'withheld'} result`);
  res.json({ success: true, data: { result } });
});

// GET /api/results/summary/exam/:examId
const examSummary = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'results.view')) throw new ApiError(403, 'Missing permission: results.view');
  const examId = req.params.examId;
  const stats = await Result.aggregate([
    { $match: { exam: require('mongoose').Types.ObjectId.createFromHexString(examId) } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avgScore: { $avg: '$marksObtained' },
        avgPercent: { $avg: '$percentage' },
        maxScore: { $max: '$marksObtained' },
        minScore: { $min: '$marksObtained' },
        totalCorrect: { $sum: '$correct' },
        totalIncorrect: { $sum: '$incorrect' },
        totalUnanswered: { $sum: '$unanswered' },
      },
    },
  ]);
  const histogram = await Result.aggregate([
    { $match: { exam: require('mongoose').Types.ObjectId.createFromHexString(examId) } },
    {
      $bucket: {
        groupBy: '$percentage',
        boundaries: [0, 25, 50, 75, 90, 101],
        default: 'other',
        output: { count: { $sum: 1 } },
      },
    },
  ]);
  res.json({ success: true, data: { stats: stats[0] || null, histogram } });
});

module.exports = { listResults, getResult, adjustResult, releaseResult, examSummary };
