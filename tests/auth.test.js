const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { startTestServer, stopTestServer, client, makeUser, signToken } = require('./helpers');

let superadmin;
let admin;
let student;
let subadmin;

before(async () => {
  await startTestServer();
  superadmin = await makeUser({ role: 'superadmin', email: 'sa@test.local' });
  admin = await makeUser({ role: 'admin', email: 'admin@test.local' });
  student = await makeUser({ role: 'student', email: 'student1@test.local' });
  subadmin = await makeUser({ role: 'subadmin', email: 'sub@test.local', permissions: ['students.view'] });
});

after(async () => {
  await stopTestServer();
});

describe('Authentication', () => {
  test('login returns user and token, no password hash', async () => {
    const c = client();
    const r = await c.login('sa@test.local', 'Passw0rd!123');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.user.role, 'superadmin');
    assert.equal(r.body.data.user.password, undefined);
    assert.ok(r.body.data.accessToken);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, 'sa@test.local');
  });

  test('wrong password rejected with generic error', async () => {
    const c = client();
    const r = await c.login('sa@test.local', 'wrongpassword');
    assert.equal(r.status, 401);
    assert.match(r.body.message, /Invalid email or password/);
  });

  test('protected route without token returns 401', async () => {
    const c = client();
    const r = await c.get('/api/students');
    assert.equal(r.status, 401);
  });

  test('change password flow works', async () => {
    const u = await makeUser({ role: 'student', email: 'chpw@test.local' });
    const c = client();
    await c.login('chpw@test.local', 'Passw0rd!123');
    const bad = await c.post('/api/auth/change-password', { body: { currentPassword: 'nope', newPassword: 'NewPass123!' } });
    assert.equal(bad.status, 400);
    const ok = await c.post('/api/auth/change-password', { body: { currentPassword: 'Passw0rd!123', newPassword: 'NewPass123!' } });
    assert.equal(ok.status, 200);
    const relogin = await c.login('chpw@test.local', 'NewPass123!');
    assert.equal(relogin.status, 200);
  });

  test('passwords are stored hashed, never plaintext', async () => {
    const User = require('../models/User');
    const u = await User.findOne({ email: 'chpw@test.local' }).select('+password');
    assert.notEqual(u.password, 'NewPass123!');
    assert.match(u.password, /^\$2[aby]\$/);
  });
});

describe('Role-based access control', () => {
  test('student cannot list students', async () => {
    const c = client();
    c.token = signToken(student);
    const r = await c.get('/api/students', { token: c.token });
    assert.equal(r.status, 403);
  });

  test('subadmin with students.view can list but not register', async () => {
    const c = client();
    const token = signToken(subadmin);
    const list = await c.get('/api/students', { token });
    assert.equal(list.status, 200);
    const reg = await c.post('/api/students', {
      token,
      body: { fullName: 'X', email: 'x@y.com', studentId: 'S1' },
    });
    assert.equal(reg.status, 403);
  });

  test('subadmin cannot access audit logs (deny-by-default)', async () => {
    const c = client();
    const r = await c.get('/api/admin/audit-logs', { token: signToken(subadmin) });
    assert.equal(r.status, 403);
  });

  test('admin cannot create another admin', async () => {
    const c = client();
    const r = await c.post('/api/users', {
      token: signToken(admin),
      body: { name: 'Evil', email: 'evil@test.local', password: 'Passw0rd!123', role: 'admin' },
    });
    assert.equal(r.status, 403);
  });

  test('admin cannot modify superadmin', async () => {
    const c = client();
    const r = await c.patch(`/api/users/${superadmin._id}`, {
      token: signToken(admin),
      body: { status: 'inactive' },
    });
    assert.equal(r.status, 403);
  });

  test('student cannot register students via admin endpoint', async () => {
    const c = client();
    const r = await c.post('/api/students', {
      token: signToken(student),
      body: { fullName: 'Hacker', email: 'h@x.com', studentId: 'H1' },
    });
    assert.equal(r.status, 403);
  });

  test('student cannot read another student result', async () => {
    const other = await makeUser({ role: 'student', email: 'other@test.local' });
    const Result = require('../models/Result');
    const Exam = require('../models/Exam');
    const Semester = require('../models/Semester');
    const sem = await Semester.create({ title: 'Sem 1', number: 1 });
    const exam = await Exam.create({
      title: 'T', semester: sem._id, subject: sem._id, durationMinutes: 10,
      startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 1000),
      questions: [{ question: other._id, marks: 1 }], status: 'published',
    });
    const attempt = require('../models/ExamAttempt');
    const a = await attempt.create({ exam: exam._id, student: other._id, status: 'submitted', startedAt: new Date(), deadline: new Date(Date.now() + 1000), questionOrder: [] });
    const resDoc = await Result.create({ exam: exam._id, attempt: a._id, student: other._id, maxMarks: 1, marksObtained: 1, percentage: 100, status: 'released' });
    const c = client();
    const r = await c.get(`/api/results/${resDoc._id}`, { token: signToken(student) });
    assert.equal(r.status, 403);
  });
});

describe('Student registration & bulk import', () => {
  test('valid single registration', async () => {
    const c = client();
    const r = await c.post('/api/students', {
      token: signToken(admin),
      body: { fullName: 'New Student', email: 'new@student.local', studentId: 'RCLD001', phone: '9876543210', semester: null, password: 'pass123' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.student.mustChangePassword, false);
    assert.equal(r.body.data.student.password, undefined);
  });

  test('duplicate email rejected', async () => {
    const c = client();
    const r = await c.post('/api/students', {
      token: signToken(admin),
      body: { fullName: 'Dup', email: 'new@student.local', studentId: 'RCLD002', password: 'pass123' },
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.email);
  });

  test('invalid email rejected', async () => {
    const c = client();
    const r = await c.post('/api/students', {
      token: signToken(admin),
      body: { fullName: 'Bad Email', email: 'not-an-email', studentId: 'RCLD003', password: 'pass123' },
    });
    assert.equal(r.status, 400);
  });

  test('search, filter and pagination work', async () => {
    const c = client();
    const r = await c.get('/api/students?search=RCLD001&limit=5', { token: signToken(admin) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.items.length, 1);
    assert.equal(r.body.data.items[0].studentId, 'RCLD001');
    assert.ok(r.body.data.total >= 1);
  });
});

describe('Semesters & subjects', () => {
  test('superadmin creates semester and subject', async () => {
    const c = client();
    const sem = await c.post('/api/academics/semesters', { token: signToken(superadmin), body: { title: 'Semester 1', number: 1 } });
    assert.equal(sem.status, 201);
    const sub = await c.post('/api/academics/subjects', {
      token: signToken(superadmin),
      body: { name: 'Mathematics', semester: sem.body.data.semester._id, code: 'MATH101' },
    });
    assert.equal(sub.status, 201);
    const list = await c.get('/api/academics/semesters', { token: signToken(superadmin) });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.items.length >= 1);
  });

  test('student cannot create semester', async () => {
    const c = client();
    const r = await c.post('/api/academics/semesters', { token: signToken(student), body: { title: 'X', number: 99 } });
    assert.equal(r.status, 403);
  });
});
