const User = require('../models/User');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const ExamAttempt = require('../models/ExamAttempt');
const Result = require('../models/Result');
const AuditLog = require('../models/AuditLog');
const Semester = require('../models/Semester');
const { asyncHandler, ApiError } = require('../middlewares/error');
const { hasPermission } = require('../config/permissions');

// GET /api/admin/dashboard
const adminDashboard = asyncHandler(async (req, res) => {
  const [students, totalStudents, inactiveStudents, exams, upcomingExams, activeExams, questions, publishedQuestions, attempts, results] =
    await Promise.all([
      User.countDocuments({ role: 'student', status: 'active' }),
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'student', status: 'inactive' }),
      Exam.countDocuments(),
      Exam.find({ startsAt: { $gt: new Date() }, status: { $in: ['published', 'scheduled'] } })
        .populate('semester subject', 'title number name')
        .sort({ startsAt: 1 })
        .limit(5),
      Exam.find({ status: 'active' }).populate('semester subject', 'title number name').limit(5),
      Question.countDocuments(),
      Question.countDocuments({ status: 'published' }),
      ExamAttempt.countDocuments({ status: { $in: ['submitted', 'auto_submitted', 'expired'] } }),
      Result.countDocuments(),
    ]);

  const recentActivity = await AuditLog.find().sort({ createdAt: -1 }).limit(15).populate('actor', 'name role');

  const questionsBySubject = await Question.aggregate([
    { $group: { _id: '$subject', count: { $sum: 1 }, published: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } } } },
    { $lookup: { from: 'subjects', localField: '_id', foreignField: '_id', as: 's' } },
    { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, subjectId: '$_id', subject: { $ifNull: ['$s.name', 'Unassigned'] }, count: 1, published: 1 } },
    { $sort: { count: -1 } },
  ]);

  res.json({
    success: true,
    data: {
      counts: {
        students,
        totalStudents,
        inactiveStudents,
        exams,
        questions,
        publishedQuestions,
        attempts,
        results,
      },
      upcomingExams,
      activeExams,
      questionsBySubject,
      recentActivity,
      serverTime: new Date(),
    },
  });
});

// GET /api/admin/audit-logs
const auditLogs = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'audit.view')) throw new ApiError(403, 'Missing permission: audit.view');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const filter = {};
  if (req.query.action) filter.action = new RegExp(String(req.query.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (req.query.entity) filter.entity = req.query.entity;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ summary: rx }, { action: rx }];
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('actor', 'name email role'),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

// GET /api/admin/stats/overview — for charts backed by real data
const overviewStats = asyncHandler(async (req, res) => {
  const [bySemester, submissionsByDay, resultBuckets] = await Promise.all([
    User.aggregate([
      { $match: { role: 'student' } },
      { $group: { _id: '$semester', count: { $sum: 1 } } },
      { $lookup: { from: 'semesters', localField: '_id', foreignField: '_id', as: 's' } },
      { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, label: { $ifNull: ['$s.title', 'Unassigned'] }, count: 1 } },
      { $sort: { label: 1 } },
    ]),
    Result.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt' } },
          count: { $sum: 1 },
          avg: { $avg: '$percentage' },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 14 },
    ]),
    Result.aggregate([
      {
        $bucket: {
          groupBy: '$percentage',
          boundaries: [0, 25, 50, 75, 90, 101],
          default: 'other',
          output: { count: { $sum: 1 } },
        },
      },
    ]),
  ]);
  res.json({ success: true, data: { bySemester, submissionsByDay: submissionsByDay.reverse(), resultBuckets } });
});

module.exports = { adminDashboard, auditLogs, overviewStats };
