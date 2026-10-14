const Semester = require('../models/Semester');
const Subject = require('../models/Subject');
const User = require('../models/User');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');

// ---- Semesters ----
const listSemesters = asyncHandler(async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : {};
  const items = await Semester.find(filter).sort({ order: 1, number: 1 });
  res.json({ success: true, data: { items } });
});

const createSemester = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'semesters.manage')) throw new ApiError(403, 'Missing permission: semesters.manage');
  const { title, number, course = '', description = '', status = 'active', order } = req.validated || req.body;
  const sem = await Semester.create({ title, number, course, description, status, order: order ?? number });
  await audit(req, 'semester.create', 'Semester', sem._id, `created ${sem.title}`);
  res.status(201).json({ success: true, data: { semester: sem } });
});

const updateSemester = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'semesters.manage')) throw new ApiError(403, 'Missing permission: semesters.manage');
  const sem = await Semester.findById(req.params.id);
  if (!sem) throw new ApiError(404, 'Semester not found');
  const { title, number, course, description, status, order } = req.body || {};
  if (title !== undefined) sem.title = title;
  if (number !== undefined) sem.number = Number(number);
  if (course !== undefined) sem.course = course;
  if (description !== undefined) sem.description = description;
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) throw new ApiError(400, 'Invalid status');
    sem.status = status;
  }
  if (order !== undefined) sem.order = Number(order);
  await sem.save();
  await audit(req, 'semester.update', 'Semester', sem._id, `updated ${sem.title}`);
  res.json({ success: true, data: { semester: sem } });
});

const deleteSemester = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'semesters.manage')) throw new ApiError(403, 'Missing permission: semesters.manage');
  const sem = await Semester.findById(req.params.id);
  if (!sem) throw new ApiError(404, 'Semester not found');
  const [students, exams, questions, subjects] = await Promise.all([
    User.countDocuments({ semester: sem._id }),
    Exam.countDocuments({ semester: sem._id }),
    Question.countDocuments({ semester: sem._id }),
    Subject.countDocuments({ semester: sem._id }),
  ]);
  if (students || exams || questions) {
    throw new ApiError(409, 'Semester is in use', { students, exams, questions, subjects });
  }
  await Subject.deleteMany({ semester: sem._id });
  await sem.deleteOne();
  await audit(req, 'semester.delete', 'Semester', sem._id, `deleted ${sem.title}`);
  res.json({ success: true, message: 'Semester deleted' });
});

// ---- Subjects ----
const listSubjects = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.semester) filter.semester = req.query.semester;
  if (req.query.status) filter.status = req.query.status;
  const items = await Subject.find(filter).populate('semester', 'title number').sort({ name: 1 });
  res.json({ success: true, data: { items } });
});

const createSubject = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'subjects.manage')) throw new ApiError(403, 'Missing permission: subjects.manage');
  const { name, code = '', semester, description = '', status = 'active' } = req.validated || req.body;
  const sub = await Subject.create({ name, code, semester, description, status });
  await audit(req, 'subject.create', 'Subject', sub._id, `created ${sub.name}`);
  res.status(201).json({ success: true, data: { subject: sub } });
});

const updateSubject = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'subjects.manage')) throw new ApiError(403, 'Missing permission: subjects.manage');
  const sub = await Subject.findById(req.params.id);
  if (!sub) throw new ApiError(404, 'Subject not found');
  const { name, code, semester, description, status } = req.body || {};
  if (name !== undefined) sub.name = name;
  if (code !== undefined) sub.code = code;
  if (semester !== undefined) sub.semester = semester;
  if (description !== undefined) sub.description = description;
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) throw new ApiError(400, 'Invalid status');
    sub.status = status;
  }
  await sub.save();
  await audit(req, 'subject.update', 'Subject', sub._id, `updated ${sub.name}`);
  res.json({ success: true, data: { subject: sub } });
});

const deleteSubject = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'subjects.manage')) throw new ApiError(403, 'Missing permission: subjects.manage');
  const sub = await Subject.findById(req.params.id);
  if (!sub) throw new ApiError(404, 'Subject not found');
  const [exams, questions] = await Promise.all([
    Exam.countDocuments({ subject: sub._id }),
    Question.countDocuments({ subject: sub._id }),
  ]);
  if (exams || questions) throw new ApiError(409, 'Subject is in use', { exams, questions });
  await sub.deleteOne();
  await audit(req, 'subject.delete', 'Subject', sub._id, `deleted ${sub.name}`);
  res.json({ success: true, message: 'Subject deleted' });
});

module.exports = {
  listSemesters,
  createSemester,
  updateSemester,
  deleteSemester,
  listSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
};
