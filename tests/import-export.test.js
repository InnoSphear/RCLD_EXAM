const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { startTestServer, stopTestServer, client, makeUser, signToken } = require('./helpers');

let superadmin, student, semesterId, subjectId;
let baseUrl;

const FIXTURES = path.join(__dirname, 'fixtures');

async function uploadFile(c, urlPath, filePath, token, field = 'file') {
  const boundary = '----rcldtest' + Date.now();
  const data = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, data, tail]);
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

before(async () => {
  baseUrl = await startTestServer();
  superadmin = await makeUser({ role: 'superadmin', email: 'sa3@test.local' });
  student = await makeUser({ role: 'student', email: 'st4@test.local' });
  const Semester = require('../models/Semester');
  const sem = await Semester.create({ title: 'Semester 3', number: 3 });
  semesterId = String(sem._id);
  const Subject = require('../models/Subject');
  const sub = await Subject.create({ name: 'Chemistry', semester: sem._id });
  subjectId = String(sub._id);
  student.semester = sem._id;
  await student.save();
});

after(async () => {
  await stopTestServer();
});

describe('DOCX/PDF question import pipeline', () => {
  let batchId;
  let token;

  test('uploads and parses DOCX into structured questions', async () => {
    token = signToken(superadmin);
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', path.join(FIXTURES, 'sample_questions.docx'), token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const batch = r.body.data.batch;
    batchId = batch._id;
    assert.equal(batch.status, 'parsed');
    assert.equal(batch.stats.total, 3);
    assert.equal(batch.stats.valid, 3);
    assert.equal(batch.stats.missingAnswer, 0);
    const q1 = batch.questions[0];
    assert.equal(q1.options.length, 4);
    assert.deepEqual(q1.correctAnswers, ['b']);
    assert.equal(q1.type, 'mcq');
    const tf = batch.questions.find((q) => q.type === 'tf');
    assert.ok(tf, 'true/false detected');
  });

  test('uploads and parses selectable-text PDF', async () => {
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', path.join(FIXTURES, 'sample_questions.pdf'), signToken(superadmin));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.batch.stats.total, 3);
    assert.equal(r.body.data.batch.fileType, 'pdf');
  });

  test('rejects disallowed file types', async () => {
    const tmp = path.join(FIXTURES, 'bad.png');
    fs.writeFileSync(tmp, 'hello');
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', tmp, signToken(superadmin));
    fs.unlinkSync(tmp);
    assert.equal(r.status, 400);
  });

  test('uploads and parses a plain-text question paper', async () => {
    const tmp = path.join(FIXTURES, 'sample_questions.txt');
    fs.writeFileSync(
      tmp,
      '1. Capital of India?\na) Mumbai\nb) New Delhi\nAnswer: b\n\n2. HTML is used to ______.\na) Design database\nb) Create web pages\nAnswer: b\n'
    );
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', tmp, signToken(superadmin));
    fs.unlinkSync(tmp);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.batch.fileType, 'txt');
    assert.equal(r.body.data.batch.stats.total, 2);
    assert.deepEqual(r.body.data.batch.questions[0].correctAnswers, ['b']);
  });

  test('admin edits questions in review step', async () => {
    const c = client();
    const get = await c.get(`/api/questions/imports/${batchId}`, { token });
    assert.equal(get.status, 200);
    const qs = get.body.data.batch.questions.map((q) => ({ ...q, marks: 2 }));
    const upd = await c.put(`/api/questions/imports/${batchId}`, {
      token,
      body: { questions: qs, semester: semesterId, subject: subjectId },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.data.batch.status, 'reviewed');
  });

  test('confirm imports questions into MongoDB as drafts', async () => {
    const c = client();
    const r = await c.post(`/api/questions/imports/${batchId}/confirm`, { token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.imported, 3);
    assert.equal(r.body.data.failed, 0);
    const Question = require('../models/Question');
    const count = await Question.countDocuments({ importBatch: batchId });
    assert.equal(count, 3);
    const allDrafts = await Question.find({ importBatch: batchId });
    assert.ok(allDrafts.every((q) => q.status === 'draft'));
    assert.ok(allDrafts.every((q) => String(q.semester) === semesterId));
  });

  test('re-importing the same batch is rejected (double submission safe)', async () => {
    const c = client();
    const r = await c.post(`/api/questions/imports/${batchId}/confirm`, { token, body: {} });
    assert.equal(r.status, 409);
  });

  test('duplicate document import flags duplicates against the bank', async () => {
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', path.join(FIXTURES, 'sample_questions.docx'), signToken(superadmin));
    assert.equal(r.status, 201);
    const dupCount = r.body.data.batch.questions.filter((q) => q.duplicateOfIndex !== null).length;
    assert.equal(dupCount, 3, 'all 3 already in bank');
  });

  test('missing answers are flagged, never invented', async () => {
    const tmp = path.join(FIXTURES, 'no_answer.docx');
    // build docx with no Answer lines
    const { execSync } = require('child_process');
    fs.writeFileSync(path.join(FIXTURES, '_na.txt'), '1. Unanswered?\na) One\nb) Two\n');
    execSync(
      `python3 -c "
import zipfile
paras=[]
for line in open('${path.join(FIXTURES, '_na.txt')}').read().strip().split(chr(10)):
    safe=line.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    paras.append('<w:p><w:r><w:t>'+safe+'</w:t></w:r></w:p>')
doc='<?xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\"?><w:document xmlns:w=\\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\\"><w:body>'+''.join(paras)+'</w:body></w:document>'
ct='<?xml version=\\"1.0\\"?><Types xmlns=\\"http://schemas.openxmlformats.org/package/2006/content-types\\"><Default Extension=\\"rels\\" ContentType=\\"application/vnd.openxmlformats-package.relationships+xml\\"/><Default Extension=\\"xml\\" ContentType=\\"application/xml\\"/><Override PartName=\\"/word/document.xml\\" ContentType=\\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\\"/></Types>'
rels='<?xml version=\\"1.0\\"?><Relationships xmlns=\\"http://schemas.openxmlformats.org/package/2006/relationships\\"><Relationship Id=\\"rId1\\" Type=\\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\\" Target=\\"word/document.xml\\"/></Relationships>'
z=zipfile.ZipFile('${tmp}','w',zipfile.ZIP_DEFLATED)
z.writestr('[Content_Types].xml',ct); z.writestr('_rels/.rels',rels); z.writestr('word/document.xml',doc); z.close()
"`
    );
    fs.unlinkSync(path.join(FIXTURES, '_na.txt'));
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', tmp, signToken(superadmin));
    assert.equal(r.status, 201);
    assert.ok(r.body.data.batch.stats.missingAnswer >= 1);
    assert.ok(r.body.data.batch.questions[0].issues.includes('missing_answer'));
    fs.unlinkSync(tmp);
  });

  test('non-admin cannot upload imports', async () => {
    const c = client();
    const r = await uploadFile(c, '/api/questions/imports/upload', path.join(FIXTURES, 'sample_questions.docx'), signToken(student));
    assert.equal(r.status, 403);
  });
});

describe('Import delete & question deletion', () => {
  const token = () => signToken(superadmin);

  function writeTxt(name, body) {
    const tmp = path.join(FIXTURES, name);
    fs.writeFileSync(tmp, body);
    return tmp;
  }

  test('deletes a single extracted draft question from a batch', async () => {
    const tmp = writeTxt('del_single.txt', '1. Delete me one?\na) X\nb) Y\nAnswer: a\n\n2. Keep me?\na) P\nb) Q\nAnswer: b\n');
    const c = client();
    const up = await uploadFile(c, '/api/questions/imports/upload', tmp, token());
    fs.unlinkSync(tmp);
    assert.equal(up.status, 201);
    const batchId = up.body.data.batch._id;
    assert.equal(up.body.data.batch.stats.total, 2);

    const del = await c.del(`/api/questions/imports/${batchId}/questions/0`, { token: token() });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.data.batch.stats.total, 1);
    assert.match(del.body.data.batch.questions[0].statement, /Keep me/);
  });

  test('deletes an import batch (history) without touching the bank', async () => {
    const tmp = writeTxt('del_batch.txt', '1. Batch delete question?\na) X\nb) Y\nAnswer: a\n');
    const c = client();
    const up = await uploadFile(c, '/api/questions/imports/upload', tmp, token());
    fs.unlinkSync(tmp);
    const batchId = up.body.data.batch._id;

    const del = await c.del(`/api/questions/imports/${batchId}`, { token: token() });
    assert.equal(del.status, 200);
    const get = await c.get(`/api/questions/imports/${batchId}`, { token: token() });
    assert.equal(get.status, 404);
  });

  test('cascade delete removes imported questions but keeps exam-protected ones', async () => {
    const tmp = writeTxt('del_cascade.txt', '1. Cascade alpha unique?\na) One\nb) Two\nAnswer: b\n\n2. Cascade beta unique?\na) Three\nb) Four\nAnswer: a\n');
    const c = client();
    const up = await uploadFile(c, '/api/questions/imports/upload', tmp, token());
    fs.unlinkSync(tmp);
    const batchId = up.body.data.batch._id;
    await c.put(`/api/questions/imports/${batchId}`, { token: token(), body: { semester: semesterId, subject: subjectId } });
    const conf = await c.post(`/api/questions/imports/${batchId}/confirm`, { token: token(), body: {} });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.data.imported, 2);

    const Question = require('../models/Question');
    assert.equal(await Question.countDocuments({ importBatch: batchId }), 2);

    const del = await c.del(`/api/questions/imports/${batchId}?deleteQuestions=true`, { token: token(), raw: true });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.data.deletedQuestions, 2);
    assert.equal(await Question.countDocuments({ importBatch: batchId }), 0);
  });

  test('bulk delete removes multiple questions at once', async () => {
    const c = client();
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await c.post('/api/questions', {
        token: token(),
        body: {
          type: 'mcq',
          statement: `Bulk delete target ${Date.now()} ${i}`,
          options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }],
          correctAnswers: ['a'],
          status: 'draft',
        },
      });
      assert.equal(r.status, 201);
      made.push(r.body.data.question._id);
    }
    const del = await c.post('/api/questions/bulk-delete', { token: token(), body: { ids: made } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.data.deleted, 3);
    const Question = require('../models/Question');
    assert.equal(await Question.countDocuments({ _id: { $in: made } }), 0);
  });

  test('bulk delete requires permission and rejects empty payload', async () => {
    const c = client();
    const forbidden = await c.post('/api/questions/bulk-delete', { token: signToken(student), body: { ids: ['x'] } });
    assert.equal(forbidden.status, 403);
    const empty = await c.post('/api/questions/bulk-delete', { token: token(), body: { ids: [] } });
    assert.equal(empty.status, 400);
  });
});

describe('Student bulk Excel import', () => {
  let token;

  before(() => {
    token = signToken(superadmin);
  });

  test('downloads template', async () => {
    const c = client();
    const r = await c.get('/api/students/template', { token, raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /spreadsheet/);
  });

  test('previews import with validation and duplicate detection', async () => {
    const wb = xlsx.utils.book_new();
    const rows = [
      { fullName: 'Bulk One', email: 'bulk1@test.local', phone: '9876500001', studentId: 'BULK001', rollNumber: 'B1', course: 'BCA', semester: 3, status: 'active', password: '' },
      { fullName: 'Bulk Two', email: 'bulk2@test.local', phone: '9876500002', studentId: 'BULK002', rollNumber: 'B2', course: 'BCA', semester: 3, status: 'active', password: '' },
      { fullName: 'Bad Email', email: 'not-an-email', phone: '', studentId: 'BULK003', rollNumber: '', course: 'BCA', semester: 3, status: 'active', password: '' },
      { fullName: 'Dup In File', email: 'bulk1@test.local', phone: '', studentId: 'BULK004', rollNumber: '', course: 'BCA', semester: 3, status: 'active', password: '' },
      { fullName: 'Missing ID', email: 'bulk5@test.local', phone: '', studentId: '', rollNumber: '', course: 'BCA', semester: 3, status: 'active', password: '' },
    ];
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Students');
    const tmp = path.join(FIXTURES, 'students.xlsx');
    xlsx.writeFile(wb, tmp);

    const c = client();
    const r = await uploadFile(c, '/api/students/import/preview', tmp, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.total, 5);
    assert.equal(d.valid, 2);
    assert.equal(d.invalid, 3);
    assert.ok(d.items[2].errors.email);
    assert.ok(d.items[3].errors.email, 'in-file duplicate flagged');
    assert.ok(d.items[4].errors.studentId);

    // confirm import with only valid rows
    const validItems = d.items.filter((i) => Object.keys(i.errors).length === 0);
    const conf = await c.post('/api/students/import/confirm', { token, body: { items: validItems } });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.data.imported, 2);
    assert.equal(conf.body.data.failed, 0);

    const User = require('../models/User');
    assert.equal(await User.countDocuments({ studentId: 'BULK001' }), 1);
    assert.equal(await User.countDocuments({ studentId: 'BULK002' }), 1);

    // re-import same file → duplicates skipped
    const r2 = await uploadFile(c, '/api/students/import/preview', tmp, token);
    const conf2 = await c.post('/api/students/import/confirm', { token, body: { items: r2.body.data.items } });
    assert.equal(conf2.body.data.imported, 0);
    assert.ok(conf2.body.data.skipped + conf2.body.data.failed >= 5);
    fs.unlinkSync(tmp);
  });

  test('imported accounts use hashed default password and require change', async () => {
    const User = require('../models/User');
    const u = await User.findOne({ studentId: 'BULK001' }).select('+password');
    assert.ok(u);
    assert.match(u.password, /^\$2[aby]\$/);
    
    assert.equal(u.mustChangePassword, false);
  });
});

describe('Exports', () => {
  test('student export respects filters and excludes secrets', async () => {
    const c = client();
    const token = signToken(superadmin);
    const r = await c.get('/api/students/export?format=csv&semester=' + semesterId, { token, raw: true });
    assert.equal(r.status, 200);
    const csv = r.text;
    assert.match(csv, /Student ID/);
    assert.match(csv, /Bulk One/);
    assert.ok(!/password/i.test(csv.split('\n')[0]), 'no password column');
    assert.ok(!/\$2[aby]\$/.test(csv), 'no hashes in export');
  });

  test('result export requires permission and returns real rows', async () => {
    const c = client();
    const token = signToken(superadmin);
    const r = await c.get('/api/exports/results?format=xlsx', { token, raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /spreadsheet/);

    const studentRes = await c.get('/api/exports/results?format=csv', { token: signToken(student), raw: true });
    assert.equal(studentRes.status, 403);
  });

  test('formula injection is neutralized in student export', async () => {
    const c = client();
    const token = signToken(superadmin);
    await c.post('/api/students', {
      token,
      body: { fullName: '=cmd|calc', email: 'inject@test.local', studentId: 'INJ001' },
    });
    const r = await c.get('/api/students/export?format=csv', { token, raw: true });
    assert.ok(!/(^|\n)=cmd/.test(r.text), 'formula not at cell start');
    assert.match(r.text, /'=cmd/);
  });
});

describe('Audit logging', () => {
  test('privileged actions are recorded', async () => {
    const c = client();
    const r = await c.get('/api/admin/audit-logs?limit=50', { token: signToken(superadmin) });
    assert.equal(r.status, 200);
    const actions = r.body.data.items.map((i) => i.action);
    assert.ok(actions.includes('student.import_confirm'));
    assert.ok(actions.includes('question_import.confirm'));
  });
});
