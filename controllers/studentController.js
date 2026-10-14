const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const Semester = require('../models/Semester');
const { env } = require('../config/env');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');

const STUDENT_COLUMNS = [
  'fullName',
  'email',
  'phone',
  'studentId',
  'rollNumber',
  'course',
  'semester',
  'status',
  'password',
];

function buildStudentFilter(query) {
  const filter = { role: 'student' };
  if (query.search) {
    const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { studentId: rx }, { rollNumber: rx }];
  }
  if (query.status) filter.status = query.status;
  if (query.course) filter.course = new RegExp(`^${String(query.course).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (query.semester) filter.semester = query.semester;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
  }
  return filter;
}

// GET /api/students
const listStudents = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.view')) throw new ApiError(403, 'Missing permission: students.view');
  const { page = 1, limit = 20, sort = '-createdAt' } = req.query;
  const filter = buildStudentFilter(req.query);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
  const allowedSorts = ['createdAt', '-createdAt', 'name', '-name', 'email', '-email', 'studentId', '-studentId'];
  const sortSpec = allowedSorts.includes(sort) ? sort : '-createdAt';

  const [items, total] = await Promise.all([
    User.find(filter)
      .populate('semester', 'title number')
      .sort(sortSpec)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    User.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: { items: items.map((u) => u.toSafeJSON()), total, page: pageNum, limit: limitNum },
  });
});

// GET /api/students/:id
const getStudent = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.view')) throw new ApiError(403, 'Missing permission: students.view');
  const student = await User.findOne({ _id: req.params.id, role: 'student' }).populate('semester', 'title number');
  if (!student) throw new ApiError(404, 'Student not found');
  res.json({ success: true, data: { student: student.toSafeJSON() } });
});

async function resolveSemester(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (/^[0-9a-fA-F]{24}$/.test(str)) return str;
  const asNum = Number(str);
  const sem = await Semester.findOne(
    Number.isFinite(asNum) ? { number: asNum } : { title: new RegExp(`^${str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
  );
  if (!sem) throw new ApiError(400, `Unknown semester: ${str}`);
  return sem._id;
}

async function createStudentRecord(payload, createdBy, defaultPassword) {
  const errors = {};
  const name = String(payload.fullName || payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const phone = String(payload.phone || '').trim();
  const studentId = String(payload.studentId || '').trim();
  const rollNumber = String(payload.rollNumber || '').trim();
  const course = String(payload.course || '').trim();
  const status = ['active', 'inactive'].includes(payload.status) ? payload.status : 'active';
  const password = String(payload.password || '').trim() || String(defaultPassword || '').trim();
  
  if (!name) errors.fullName = 'Full name is required';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Valid email is required';
  if (!studentId) errors.studentId = 'Student ID is required';
  if (phone && !/^[+\d][\d\s-]{7,15}$/.test(phone)) errors.phone = 'Invalid phone number';
  if (!password) errors.password = 'Password is required';
  if (password && password.length < 6) errors.password = 'Password must be at least 6 characters';
  
  if (Object.keys(errors).length) return { ok: false, errors };

  if (await User.exists({ email })) errors.email = 'Email already exists';
  if (await User.exists({ studentId })) errors.studentId = 'Student ID already exists';
  if (rollNumber && (await User.exists({ rollNumber, role: 'student' }))) errors.rollNumber = 'Roll number already exists';
  if (Object.keys(errors).length) return { ok: false, errors };

  const semester = await resolveSemester(payload.semester);
  const student = await User.create({
    name,
    email,
    phone,
    studentId,
    rollNumber,
    course,
    semester,
    role: 'student',
    status,
    password: await bcrypt.hash(password, 12),
    mustChangePassword: false,
    createdBy: createdBy._id,
  });
  return { ok: true, student };
}

// POST /api/students
const registerStudent = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.register')) throw new ApiError(403, 'Missing permission: students.register');
  const result = await createStudentRecord(req.validated || req.body, req.user, env.DEFAULT_STUDENT_PASSWORD);
  if (!result.ok) throw new ApiError(400, 'Validation failed', result.errors);
  await audit(req, 'student.register', 'Student', result.student._id, `registered ${result.student.email}`);
  res.status(201).json({ success: true, data: { student: result.student.toSafeJSON() } });
});

// PATCH /api/students/:id
const updateStudent = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.edit')) throw new ApiError(403, 'Missing permission: students.edit');
  const student = await User.findOne({ _id: req.params.id, role: 'student' });
  if (!student) throw new ApiError(404, 'Student not found');
  const { name, phone, rollNumber, course, semester, status, password, email, studentId } = req.body || {};
  const errors = {};
  if (email !== undefined) {
    const e = String(email).toLowerCase().trim();
    if (await User.exists({ email: e, _id: { $ne: student._id } })) errors.email = 'Email already exists';
    student.email = e;
  }
  if (studentId !== undefined) {
    const s = String(studentId).trim();
    if (await User.exists({ studentId: s, _id: { $ne: student._id } })) errors.studentId = 'Student ID already exists';
    student.studentId = s;
  }
  if (name !== undefined) student.name = String(name).trim();
  if (phone !== undefined) student.phone = String(phone).trim();
  if (rollNumber !== undefined) {
    const r = String(rollNumber).trim();
    if (r && (await User.exists({ rollNumber: r, role: 'student', _id: { $ne: student._id } }))) {
      errors.rollNumber = 'Roll number already exists';
    }
    student.rollNumber = r;
  }
  if (course !== undefined) student.course = String(course).trim();
  if (semester !== undefined) student.semester = await resolveSemester(semester);
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) errors.status = 'Invalid status';
    else student.status = status;
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'Validation failed', errors);
  if (password) {
    student.password = await bcrypt.hash(String(password), 12);
    student.mustChangePassword = true;
    student.passwordChangedAt = new Date();
  }
  await student.save();
  await audit(req, 'student.update', 'Student', student._id, `updated ${student.email}`);
  res.json({ success: true, data: { student: student.toSafeJSON() } });
});

// POST /api/students/bulk-status  { ids: [], status }
const bulkStatus = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.edit')) throw new ApiError(403, 'Missing permission: students.edit');
  const { ids, status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 'ids array required');
  if (!['active', 'inactive'].includes(status)) throw new ApiError(400, 'Invalid status');
  const result = await User.updateMany(
    { _id: { $in: ids }, role: 'student' },
    { $set: { status } }
  );
  await audit(req, 'student.bulk_status', 'Student', ids.join(','), `set ${result.modifiedCount} students to ${status}`);
  res.json({ success: true, data: { modified: result.modifiedCount } });
});

// POST /api/students/reset-password  { id, password? }
const resetPassword = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.edit')) throw new ApiError(403, 'Missing permission: students.edit');
  const { id, password } = req.body || {};
  const student = await User.findOne({ _id: id, role: 'student' });
  if (!student) throw new ApiError(404, 'Student not found');
  const pw = String(password || '').trim();
  if (!pw) throw new ApiError(400, 'Password is required');
  if (pw.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  student.password = await bcrypt.hash(pw, 12);
  student.mustChangePassword = true;
  student.passwordChangedAt = new Date();
  await student.save();
  await audit(req, 'student.reset_password', 'Student', student._id, `password reset for ${student.email}`);
  res.json({ success: true, message: 'Password reset. Student must change it on next login.' });
});

// GET /api/students/template
const downloadTemplate = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.import')) throw new ApiError(403, 'Missing permission: students.import');
  const semesters = await Semester.find().sort({ number: 1 });
  const sampleSem = semesters.length ? semesters[0].number : 1;
  const rows = [
    {
      fullName: 'Example Student',
      email: 'student@example.com',
      phone: '9876543210',
      studentId: 'RCLD2026001',
      rollNumber: '001',
      course: 'BCA',
      semester: sampleSem,
      status: 'active',
      password: '',
    },
  ];
  const ws = xlsx.utils.json_to_sheet(rows, { header: STUDENT_COLUMNS });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Students');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.xlsx"');
  res.send(buf);
});

function cellStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

// POST /api/students/import/preview  (multipart file)
const previewImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.import')) throw new ApiError(403, 'Missing permission: students.import');
  if (!req.file) throw new ApiError(400, 'File is required');
  const wb = xlsx.readFile(req.file.path);
  const sheetName = wb.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  fs.unlink(req.file.path, () => {});

  const seenEmails = new Set();
  const seenIds = new Set();
  const seenRolls = new Set();
  const preview = [];
  let valid = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const record = {
      fullName: cellStr(r.fullName ?? r.name ?? r['Full Name'] ?? r['full name']),
      email: cellStr(r.email ?? r.Email ?? r['E-mail']).toLowerCase(),
      phone: cellStr(r.phone ?? r.Phone ?? r.mobile ?? r['Mobile Number']),
      studentId: cellStr(r.studentId ?? r['Student ID'] ?? r['student id'] ?? r['Registration Number']),
      rollNumber: cellStr(r.rollNumber ?? r['Roll Number'] ?? r.roll),
      course: cellStr(r.course ?? r.Course ?? r.program),
      semester: cellStr(r.semester ?? r.Semester ?? r.sem),
      status: cellStr(r.status ?? r.Status) || 'active',
      password: cellStr(r.password ?? r.Password),
    };
    const errors = {};
    if (!record.fullName) errors.fullName = 'Full name is required';
    if (!record.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) errors.email = 'Valid email required';
    if (!record.studentId) errors.studentId = 'Student ID required';
    if (seenEmails.has(record.email)) errors.email = 'Duplicate email in file';
    if (seenIds.has(record.studentId)) errors.studentId = 'Duplicate student ID in file';
    if (record.rollNumber && seenRolls.has(record.rollNumber)) errors.rollNumber = 'Duplicate roll number in file';
    seenEmails.add(record.email);
    seenIds.add(record.studentId);
    if (record.rollNumber) seenRolls.add(record.rollNumber);

    if (record.email) {
      if (await User.exists({ email: record.email })) errors.email = 'Email already exists in database';
    }
    if (record.studentId) {
      if (await User.exists({ studentId: record.studentId })) errors.studentId = 'Student ID already exists in database';
    }
    if (record.rollNumber) {
      if (await User.exists({ rollNumber: record.rollNumber, role: 'student' })) {
        errors.rollNumber = 'Roll number already exists in database';
      }
    }
    const errorList = Object.values(errors);
    if (!errorList.length) valid += 1;
    preview.push({ row: i + 2, record, errors });
  }

  await audit(req, 'student.import_preview', 'Student', '', `previewed ${rows.length} rows`);
  res.json({
    success: true,
    data: {
      fileName: req.file.originalname,
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      items: preview,
      columns: STUDENT_COLUMNS,
    },
  });
});

// POST /api/students/import/confirm  { items: [{record, errors}] } or re-upload with skipInvalid
const confirmImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.import')) throw new ApiError(403, 'Missing permission: students.import');
  const { items, skipInvalid = true } = req.body || {};
  if (!Array.isArray(items) || !items.length) throw new ApiError(400, 'items array required');

  const report = { imported: [], skipped: [], failed: [] };
  const BATCH = 50;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (item) => {
        const row = item.row || 0;
        if (item.errors && Object.keys(item.errors).length) {
          if (skipInvalid) return { row, status: 'skipped', errors: item.errors };
          return { row, status: 'failed', errors: item.errors };
        }
        try {
          const created = await createStudentRecord(item.record, req.user, env.DEFAULT_STUDENT_PASSWORD);
          if (!created.ok) return { row, status: 'failed', errors: created.errors };
          return { row, status: 'imported', email: created.student.email, studentId: created.student.studentId };
        } catch (e) {
          if (e.code === 11000) {
            return { row, status: 'skipped', errors: { general: 'Duplicate record' } };
          }
          return { row, status: 'failed', errors: { general: e.message } };
        }
      })
    );
    results.forEach((r) => report[r.status].push(r));
  }

  await audit(req, 'student.import_confirm', 'Student', '', `import: ${report.imported.length} imported`);
  res.json({
    success: true,
    data: {
      total: items.length,
      imported: report.imported.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
      report,
    },
  });
});

// GET /api/students/export?format=xlsx|csv&...filters
const exportStudents = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'students.export')) throw new ApiError(403, 'Missing permission: students.export');
  const format = ['xlsx', 'csv'].includes(req.query.format) ? req.query.format : 'xlsx';
  const filter = buildStudentFilter(req.query);
  const students = await User.find(filter).populate('semester', 'title number').sort({ createdAt: 1 }).lean();

  const rows = students.map((s) => ({
    'Student ID': s.studentId || '',
    'Roll Number': s.rollNumber || '',
    'Student Name': s.name,
    Email: s.email,
    'Mobile Number': s.phone || '',
    Course: s.course || '',
    Semester: s.semester ? s.semester.title : '',
    Status: s.status,
    'Registered On': s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : '',
  }));

  const safeRows = rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      const s = String(v ?? '');
      out[k] = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    }
    return out;
  });

  const ws = xlsx.utils.json_to_sheet(safeRows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Students');
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `students_export_${stamp}.${format}`;
  let buf;
  if (format === 'csv') {
    const csv = xlsx.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
    await audit(req, 'student.export', 'Student', '', `exported ${rows.length} students (csv)`);
    return;
  }
  buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
  await audit(req, 'student.export', 'Student', '', `exported ${rows.length} students (xlsx)`);
});

module.exports = {
  listStudents,
  getStudent,
  registerStudent,
  updateStudent,
  bulkStatus,
  resetPassword,
  downloadTemplate,
  previewImport,
  confirmImport,
  exportStudents,
  STUDENT_COLUMNS,
};
