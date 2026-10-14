const xlsx = require('xlsx');
const Result = require('../models/Result');
const User = require('../models/User');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');

function sanitizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const s = v === null || v === undefined ? '' : String(v);
    out[k] = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  }
  return out;
}

function sendWorkbook(res, rows, headers, filenameBase, format) {
  const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${filenameBase}_${stamp}.${format}`;
  if (format === 'csv') {
    const csv = xlsx.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
    return filename;
  }
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Report');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
  return filename;
}

// GET /api/exports/results?format=xlsx|csv&exam=&semester=&subject=&from=&to=&minScore=&maxScore=&status=
const exportResults = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'results.export')) throw new ApiError(403, 'Missing permission: results.export');
  const format = ['xlsx', 'csv'].includes(req.query.format) ? req.query.format : 'xlsx';
  const filter = {};
  if (req.query.exam) filter.exam = req.query.exam;
  if (req.query.semester) filter.semester = req.query.semester;
  if (req.query.subject) filter.subject = req.query.subject;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.passStatus) filter.passStatus = req.query.passStatus;
  if (req.query.minScore !== undefined && req.query.minScore !== '') filter.percentage = { ...filter.percentage, $gte: Number(req.query.minScore) };
  if (req.query.maxScore !== undefined && req.query.maxScore !== '') filter.percentage = { ...filter.percentage, $lte: Number(req.query.maxScore) };
  if (req.query.from || req.query.to) {
    filter.submittedAt = {};
    if (req.query.from) filter.submittedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.submittedAt.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
  }

  const results = await Result.aggregate([
    { $match: filter },
    { $lookup: { from: 'users', localField: 'student', foreignField: '_id', as: 's' } },
    { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'exams', localField: 'exam', foreignField: '_id', as: 'e' } },
    { $unwind: { path: '$e', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'semesters', localField: 'semester', foreignField: '_id', as: 'sem' } },
    { $unwind: { path: '$sem', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'subjects', localField: 'subject', foreignField: '_id', as: 'sub' } },
    { $unwind: { path: '$sub', preserveNullAndEmptyArrays: true } },
    { $sort: { submittedAt: 1, 's.studentId': 1 } },
  ]);

  const headers = [
    'Student ID',
    'Roll Number',
    'Student Name',
    'Email',
    'Course',
    'Semester',
    'Subject',
    'Examination Title',
    'Attempt Status',
    'Start Time',
    'Submission Time',
    'Correct Answers',
    'Incorrect Answers',
    'Unanswered Questions',
    'Marks Obtained',
    'Maximum Marks',
    'Percentage',
    'Result Status',
  ];

  const rows = results.map((r) =>
    sanitizeRow({
      'Student ID': r.s ? r.s.studentId : '',
      'Roll Number': r.s ? r.s.rollNumber : '',
      'Student Name': r.s ? r.s.name : '',
      Email: r.s ? r.s.email : '',
      Course: r.s ? r.s.course : '',
      Semester: r.sem ? r.sem.title : '',
      Subject: r.sub ? r.sub.name : '',
      'Examination Title': r.e ? r.e.title : '',
      'Attempt Status': r.status,
      'Start Time': r.submittedAt ? '' : '',
      'Submission Time': r.submittedAt ? new Date(r.submittedAt).toISOString() : '',
      'Correct Answers': r.correct,
      'Incorrect Answers': r.incorrect,
      'Unanswered Questions': r.unanswered,
      'Marks Obtained': r.marksObtained,
      'Maximum Marks': r.maxMarks,
      Percentage: r.percentage,
      'Result Status': r.passStatus,
    })
  );

  const filename = sendWorkbook(res, rows, headers, 'results_export', format);
  await audit(req, 'result.export', 'Result', '', `exported ${rows.length} results (${format}) as ${filename}`);
});

// GET /api/exports/results-attempts?format= — attempts (incl. in-progress) with timing
const exportAttempts = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'results.export')) throw new ApiError(403, 'Missing permission: results.export');
  const format = ['xlsx', 'csv'].includes(req.query.format) ? req.query.format : 'xlsx';
  const filter = {};
  if (req.query.exam) filter.exam = req.query.exam;
  const ExamAttempt = require('../models/ExamAttempt');
  const attempts = await ExamAttempt.aggregate([
    { $match: filter },
    { $lookup: { from: 'users', localField: 'student', foreignField: '_id', as: 's' } },
    { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'exams', localField: 'exam', foreignField: '_id', as: 'e' } },
    { $unwind: { path: '$e', preserveNullAndEmptyArrays: true } },
    { $sort: { startedAt: 1 } },
  ]);
  const headers = [
    'Student ID',
    'Roll Number',
    'Student Name',
    'Examination Title',
    'Attempt Number',
    'Attempt Status',
    'Start Time',
    'Deadline',
    'Submission Time',
    'Questions Answered',
  ];
  const rows = attempts.map((a) =>
    sanitizeRow({
      'Student ID': a.s ? a.s.studentId : '',
      'Roll Number': a.s ? a.s.rollNumber : '',
      'Student Name': a.s ? a.s.name : '',
      'Examination Title': a.e ? a.e.title : '',
      'Attempt Number': a.attemptNumber,
      'Attempt Status': a.status,
      'Start Time': a.startedAt ? new Date(a.startedAt).toISOString() : '',
      Deadline: a.deadline ? new Date(a.deadline).toISOString() : '',
      'Submission Time': a.submittedAt ? new Date(a.submittedAt).toISOString() : '',
      'Questions Answered': a.answeredCount,
    })
  );
  const filename = sendWorkbook(res, rows, headers, 'attempts_export', format);
  await audit(req, 'attempt.export', 'ExamAttempt', '', `exported ${rows.length} attempts (${format})`);
});

module.exports = { exportResults, exportAttempts };
