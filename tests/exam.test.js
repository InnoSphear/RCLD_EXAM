const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { startTestServer, stopTestServer, client, makeUser, signToken } = require('./helpers');

let superadmin, student, student2;
let semesterId, subjectId, examId, questionIds = [];

before(async () => {
  await startTestServer();
  superadmin = await makeUser({ role: 'superadmin', email: 'sa2@test.local' });
  student = await makeUser({ role: 'student', email: 'st2@test.local' });
  student2 = await makeUser({ role: 'student', email: 'st3@test.local' });
  const Semester = require('../models/Semester');
  const Subject = require('../models/Subject');
  const sem = await Semester.create({ title: 'Semester 2', number: 2 });
  const sub = await Subject.create({ name: 'Physics', semester: sem._id });
  semesterId = String(sem._id);
  subjectId = String(sub._id);
  student.semester = sem._id;
  await student.save();
  student2.semester = sem._id;
  await student2.save();
});

after(async () => {
  await stopTestServer();
});

async function createPublishedExam(c, overrides = {}) {
  const Question = require('../models/Question');
  questionIds = [];
  const specs = [
    { statement: 'What is 2+2?', options: [{ key: 'a', text: '3' }, { key: 'b', text: '4' }], correctAnswers: ['b'] },
    { statement: 'What is 3+3?', options: [{ key: 'a', text: '6' }, { key: 'b', text: '7' }], correctAnswers: ['a'] },
    { statement: 'What is 5+5?', options: [{ key: 'a', text: '10' }, { key: 'b', text: '11' }], correctAnswers: ['a'] },
  ];
  for (const s of specs) {
    const q = await Question.create({ ...s, type: 'mcq', semester: semesterId, subject: subjectId, status: 'published', marks: 2 });
    questionIds.push(String(q._id));
  }
  const r = await c.post('/api/exams', {
    token: signToken(superadmin),
    body: {
      title: overrides.title || 'Algebra Test',
      semester: semesterId,
      subject: subjectId,
      durationMinutes: 30,
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      questions: questionIds.map((id) => ({ question: id, marks: 2 })),
      negativeMarking: true,
      maxAttempts: 1,
      ...overrides,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const createdId = r.body.data.exam._id;
  const pub = await c.post(`/api/exams/${createdId}/status`, { token: signToken(superadmin), body: { status: 'published' } });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return createdId;
}

describe('Exam creation and scheduling', () => {
  test('creates draft exam with question validation', async () => {
    const c = client();
    examId = await createPublishedExam(c);
    const got = await c.get(`/api/exams/${examId}`, { token: signToken(superadmin) });
    assert.equal(got.status, 200);
    assert.equal(got.body.data.exam.questionCount, 3);
    assert.equal(got.body.data.exam.totalMarks, 6);
    assert.equal(got.body.data.exam.status, 'published');
  });

  test('rejects exam without questions', async () => {
    const c = client();
    const r = await c.post('/api/exams', {
      token: signToken(superadmin),
      body: { title: 'Bad', semester: semesterId, subject: subjectId, durationMinutes: 10, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1000).toISOString(), questions: [] },
    });
    assert.equal(r.status, 400);
  });

  test('rejects invalid status transition', async () => {
    const c = client();
    const r = await c.post(`/api/exams/${examId}/status`, { token: signToken(superadmin), body: { status: 'draft' } });
    assert.equal(r.status, 409);
  });
});

describe('CBT engine', () => {
  let attemptId;
  const c = () => client();

  test('student cannot start exam from another semester', async () => {
    const other = await makeUser({ role: 'student', email: 'othersem@test.local' });
    const r = await c().post('/api/exam-attempts/start', { token: signToken(other), body: { examId } });
    assert.equal(r.status, 403);
  });

  test('student starts attempt with server-controlled deadline', async () => {
    const r = await c().post('/api/exam-attempts/start', { token: signToken(student), body: { examId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    attemptId = r.body.data.attempt._id;
    assert.ok(r.body.data.attempt.deadline);
    const deadline = new Date(r.body.data.attempt.deadline);
    const now = new Date();
    const deltaMin = (deadline - now) / 60000;
    assert.ok(deltaMin > 29 && deltaMin <= 31, `deadline ~30min, got ${deltaMin}`);
    assert.ok(r.body.data.attempt.questionOrder.length === 3);
  });

  test('attempt payload does not leak correct answers', async () => {
    const r = await c().get(`/api/exam-attempts/${attemptId}`, { token: signToken(student) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.questions.length === 3);
    for (const q of r.body.data.questions) {
      assert.equal(q.correctAnswers, undefined);
      assert.equal(q.explanation, undefined);
    }
    assert.ok(r.body.data.remainingMs > 0);
  });

  test('restarting resumes the same in-progress attempt (refresh recovery)', async () => {
    const r = await c().post('/api/exam-attempts/start', { token: signToken(student), body: { examId } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.resumed, true);
    assert.equal(r.body.data.attempt._id, attemptId);
  });

  test('autosave persists answers and is idempotent', async () => {
    const save = await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student),
      body: { questionId: questionIds[0], selected: ['b'] },
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.data.answeredCount, 1);
    // duplicate save of same answer
    const save2 = await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student),
      body: { questionId: questionIds[0], selected: ['b'] },
    });
    assert.equal(save2.status, 200);
    assert.equal(save2.body.data.answeredCount, 1);
    const r = await c().get(`/api/exam-attempts/${attemptId}`, { token: signToken(student) });
    assert.deepEqual(r.body.data.attempt.answers[questionIds[0]].selected, ['b']);
  });

  test('rejects answer for question not in attempt', async () => {
    const r = await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student),
      body: { questionId: 'aaaaaaaaaaaaaaaaaaaaaaaa', selected: ['a'] },
    });
    assert.equal(r.status, 400);
  });

  test('another student cannot write to this attempt', async () => {
    const r = await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student2),
      body: { questionId: questionIds[0], selected: ['a'] },
    });
    assert.equal(r.status, 403);
  });

  test('submission confirms unanswered questions, then finalizes once', async () => {
    // save a second answer
    await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student),
      body: { questionId: questionIds[1], selected: ['a'] },
    });
    const r = await c().post(`/api/exam-attempts/${attemptId}/submit`, { token: signToken(student), body: {} });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.result);
    // correct: q0=b (2 marks), q1=a (2 marks), q2 unanswered
    assert.equal(r.body.data.result.correct, 2);
    assert.equal(r.body.data.result.incorrect, 0);
    assert.equal(r.body.data.result.unanswered, 1);
    assert.equal(r.body.data.result.marksObtained, 4);
    assert.equal(r.body.data.result.maxMarks, 6);
  });

  test('duplicate submission is idempotent — no duplicate results', async () => {
    const r = await c().post(`/api/exam-attempts/${attemptId}/submit`, { token: signToken(student), body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.alreadySubmitted, true);
    const Result = require('../models/Result');
    const count = await Result.countDocuments({ attempt: attemptId });
    assert.equal(count, 1);
  });

  test('answers cannot be modified after submission', async () => {
    const r = await c().put(`/api/exam-attempts/${attemptId}/answers`, {
      token: signToken(student),
      body: { questionId: questionIds[0], selected: ['a'] },
    });
    assert.equal(r.status, 409);
  });

  test('server rejects answers after deadline and auto-finalizes', async () => {
    const exam2 = await createPublishedExam(client(), { title: 'Timed Out Exam' });
    const start = await c().post('/api/exam-attempts/start', { token: signToken(student2), body: { examId: exam2 } });
    assert.equal(start.status, 201);
    const aid = start.body.data.attempt._id;
    // force deadline into the past
    const ExamAttempt = require('../models/ExamAttempt');
    await ExamAttempt.updateOne({ _id: aid }, { $set: { deadline: new Date(Date.now() - 1000) } });
    const save = await c().put(`/api/exam-attempts/${aid}/answers`, {
      token: signToken(student2),
      body: { questionId: questionIds[0], selected: ['a'] },
    });
    assert.equal(save.status, 410);
    const after = await ExamAttempt.findById(aid);
    assert.notEqual(after.status, 'in_progress');
    // submit after expiry returns result without double scoring
    const sub = await c().post(`/api/exam-attempts/${aid}/submit`, { token: signToken(student2), body: {} });
    assert.equal(sub.status, 200);
    const Result = require('../models/Result');
    assert.equal(await Result.countDocuments({ attempt: aid }), 1);
  });

  test('max attempts enforced', async () => {
    const r = await c().post('/api/exam-attempts/start', { token: signToken(student), body: { examId } });
    assert.equal(r.status, 409);
  });

  test('exam monitor shows live attempt counts', async () => {
    const r = await c().get(`/api/exams/${examId}/monitor`, { token: signToken(superadmin) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.counts.totalAttempts >= 1, `got ${r.body.data.counts.totalAttempts}`);
    assert.ok(r.body.data.counts.started >= 1);
    assert.ok(r.body.data.registered >= 1);
    assert.ok(r.body.data.serverTime);
  });
});

describe('Negative marking', () => {
  test('wrong answer with negative marking reduces score', async () => {
    const c = client();
    const Question = require('../models/Question');
    const q = await Question.create({
      statement: 'Neg test?',
      type: 'mcq',
      options: [{ key: 'a', text: 'yes' }, { key: 'b', text: 'no' }],
      correctAnswers: ['a'],
      semester: semesterId, subject: subjectId, status: 'published', marks: 2, negativeMarks: 1,
    });
    const exam = await c.post('/api/exams', {
      token: signToken(superadmin),
      body: {
        title: 'Neg Exam', semester: semesterId, subject: subjectId, durationMinutes: 10,
        startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
        questions: [{ question: String(q._id), marks: 2 }], negativeMarking: true,
      },
    });
    const examId2 = exam.body.data.exam._id;
    await c.post(`/api/exams/${examId2}/status`, { token: signToken(superadmin), body: { status: 'published' } });
    const st = await makeUser({ role: 'student', email: 'neg@test.local', semester: semesterId });
    const start = await c.post('/api/exam-attempts/start', { token: signToken(st), body: { examId: examId2 } });
    const aid = start.body.data.attempt._id;
    await c.put(`/api/exam-attempts/${aid}/answers`, { token: signToken(st), body: { questionId: String(q._id), selected: ['b'] } });
    const sub = await c.post(`/api/exam-attempts/${aid}/submit`, { token: signToken(st), body: {} });
    assert.equal(sub.status, 200);
    assert.equal(sub.body.data.result.marksObtained, -1);
    assert.equal(sub.body.data.result.correct, 0);
    assert.equal(sub.body.data.result.incorrect, 1);
  });
});

describe('Result release policy', () => {
  test('student sees result only when released', async () => {
    const Result = require('../models/Result');
    const Exam = require('../models/Exam');
    const exam = await Exam.findOne({ title: 'Algebra Test' });
    exam.resultsReleased = false;
    exam.resultRelease = 'manual';
    await exam.save();
    const resDoc = await Result.findOne({ exam: exam._id });
    resDoc.status = 'evaluated';
    await resDoc.save();

    const c = client();
    const view = await c.get(`/api/results/${resDoc._id}`, { token: signToken(student) });
    assert.equal(view.status, 403);

    // admin releases
    await c.patch(`/api/results/${resDoc._id}/adjust`, { token: signToken(superadmin), body: { delta: 1, reason: 'bonus mark' } });
    const r2 = await Result.findById(resDoc._id);
    assert.equal(r2.marksObtained, 5);
    assert.equal(r2.manualAdjustments.length, 1);

    // release exam-level
    await c.post(`/api/exams/${exam._id}/release-results`, { token: signToken(superadmin), body: { release: true } });
    const view2 = await c.get(`/api/results/${resDoc._id}`, { token: signToken(student) });
    assert.equal(view2.status, 200);
    assert.equal(view2.body.data.result.marksObtained, 5);
  });

  test('adjust requires reason and permission', async () => {
    const Result = require('../models/Result');
    const resDoc = await Result.findOne();
    const c = client();
    const noReason = await c.patch(`/api/results/${resDoc._id}/adjust`, { token: signToken(superadmin), body: { delta: 1 } });
    assert.equal(noReason.status, 400);
    const studentAdj = await c.patch(`/api/results/${resDoc._id}/adjust`, { token: signToken(student), body: { delta: 1, reason: 'x' } });
    assert.equal(studentAdj.status, 403);
  });
});
