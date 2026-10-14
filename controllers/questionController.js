const fs = require('fs');
const Question = require('../models/Question');
const QuestionImportBatch = require('../models/QuestionImportBatch');
const Exam = require('../models/Exam');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { hasPermission } = require('../config/permissions');
const { env } = require('../config/env');
const { parseQuestions } = require('../utils/questionParser');
const { extractText } = require('../utils/extractText');
const { parseQuestionsWithAI } = require('../utils/aiQuestionParser');

const VALID_TYPES = ['mcq', 'msq', 'tf', 'fill', 'assertion', 'descriptive'];
const IMPORT_EXTS = ['pdf', 'docx', 'doc', 'txt'];

function buildQuestionFilter(query) {
  const filter = {};
  if (query.semester) filter.semester = query.semester;
  if (query.subject) filter.subject = query.subject;
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.difficulty) filter.difficulty = query.difficulty;
  if (query.search) {
    const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ statement: rx }, { topic: rx }];
  }
  return filter;
}

// GET /api/questions
const listQuestions = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.view')) throw new ApiError(403, 'Missing permission: questions.view');
  const { page = 1, limit = 20 } = req.query;
  const filter = buildQuestionFilter(req.query);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const [items, total, counts] = await Promise.all([
    Question.find(filter)
      .populate('semester', 'title number')
      .populate('subject', 'name code')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Question.countDocuments(filter),
    Question.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  res.json({
    success: true,
    data: { items, total, page: pageNum, limit: limitNum, statusCounts: counts },
  });
});

// GET /api/questions/:id
const getQuestion = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.view')) throw new ApiError(403, 'Missing permission: questions.view');
  const q = await Question.findById(req.params.id)
    .populate('semester', 'title number')
    .populate('subject', 'name code');
  if (!q) throw new ApiError(404, 'Question not found');
  res.json({ success: true, data: { question: q } });
});

function validateQuestionPayload(body, requireAnswers = true) {
  const errors = {};
  const statement = String(body.statement || '').trim();
  const type = body.type || 'mcq';
  if (!statement) errors.statement = 'Statement is required';
  if (!VALID_TYPES.includes(type)) errors.type = 'Invalid question type';
  const options = Array.isArray(body.options) ? body.options : [];
  const correctAnswers = Array.isArray(body.correctAnswers) ? body.correctAnswers.map(String) : [];

  if (['mcq', 'msq', 'tf'].includes(type)) {
    if (type === 'tf') {
      if (options.length && options.length !== 2) errors.options = 'True/False needs exactly 2 options';
    } else if (options.length < 2) {
      errors.options = 'At least 2 options are required';
    }
    const keys = options.map((o) => String(o.key || '').trim());
    if (keys.some((k) => !k)) errors.options = 'Every option needs a key';
    if (new Set(keys).size !== keys.length) errors.options = 'Option keys must be unique';
    if (requireAnswers) {
      if (!correctAnswers.length) errors.correctAnswers = 'Correct answer is required';
      else if (type !== 'fill' && correctAnswers.some((c) => !keys.includes(c))) {
        errors.correctAnswers = 'Correct answer must reference an option key';
      }
      if (type === 'msq' && correctAnswers.length < 1) errors.correctAnswers = 'Select at least one correct option';
      if (type === 'mcq' && correctAnswers.length !== 1) errors.correctAnswers = 'MCQ must have exactly one correct option';
    }
  }
  if (['fill', 'descriptive', 'assertion'].includes(type) && requireAnswers && type !== 'descriptive') {
    if (!correctAnswers.length) errors.correctAnswers = 'Correct answer is required';
  }
  return { errors, statement, type, options, correctAnswers };
}

function sanitizeOptions(options) {
  return options.map((o, i) => ({
    key: String(o.key || String.fromCharCode(97 + i)).trim().toLowerCase().slice(0, 10),
    text: String(o.text || '').trim(),
  }));
}

// POST /api/questions
const createQuestion = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.create')) throw new ApiError(403, 'Missing permission: questions.create');
  const body = req.body || {};
  const { errors, statement, type, options, correctAnswers } = validateQuestionPayload(body, body.status !== 'draft');
  if (body.status && !['draft', 'review', 'published'].includes(body.status)) errors.status = 'Invalid status';
  if (body.status === 'published' && !hasPermission(req.user, 'questions.publish')) {
    errors.status = 'Missing permission: questions.publish';
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'Validation failed', errors);

  const doc = await Question.create({
    type,
    statement,
    options: type === 'tf' && !options.length
      ? [{ key: 'true', text: 'True' }, { key: 'false', text: 'False' }]
      : sanitizeOptions(options),
    correctAnswers: correctAnswers.map((c) => String(c).toLowerCase()),
    explanation: body.explanation || '',
    marks: Number(body.marks ?? 1),
    negativeMarks: Number(body.negativeMarks ?? 0),
    semester: body.semester || null,
    subject: body.subject || null,
    topic: body.topic || '',
    difficulty: body.difficulty || 'medium',
    language: body.language || 'en',
    status: body.status || 'draft',
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  await audit(req, 'question.create', 'Question', doc._id, `created question ${doc._id}`);
  res.status(201).json({ success: true, data: { question: doc } });
});

// PATCH /api/questions/:id
const updateQuestion = asyncHandler(async (req, res) => {
  const canEdit = hasPermission(req.user, 'questions.edit');
  const canPublish = hasPermission(req.user, 'questions.publish');
  const body = req.body || {};
  const bodyKeys = Object.keys(body);
  const statusOnly = bodyKeys.length === 1 && bodyKeys[0] === 'status';

  if (!canEdit && !(canPublish && statusOnly)) throw new ApiError(403, 'Missing permission: questions.edit');

  const doc = await Question.findById(req.params.id);
  if (!doc) throw new ApiError(404, 'Question not found');

  if (statusOnly && !canEdit) {
    if (!['draft', 'review', 'published'].includes(body.status)) throw new ApiError(400, 'Invalid status');
    if (body.status === 'published' && !canPublish) throw new ApiError(403, 'Missing permission: questions.publish');
    doc.status = body.status;
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, 'question.status', 'Question', doc._id, `set question status to ${doc.status}`);
    return res.json({ success: true, data: { question: doc } });
  }

  const merged = { ...doc.toObject(), ...body };
  const { errors, statement, type, options, correctAnswers } = validateQuestionPayload(
    merged,
    (body.status || doc.status) !== 'draft'
  );
  if (body.status === 'published' && !hasPermission(req.user, 'questions.publish')) {
    errors.status = 'Missing permission: questions.publish';
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'Validation failed', errors);

  doc.statement = statement;
  doc.type = type;
  doc.options = sanitizeOptions(options);
  doc.correctAnswers = correctAnswers.map((c) => String(c).toLowerCase());
  if (body.explanation !== undefined) doc.explanation = body.explanation;
  if (body.marks !== undefined) doc.marks = Number(body.marks);
  if (body.negativeMarks !== undefined) doc.negativeMarks = Number(body.negativeMarks);
  if (body.semester !== undefined) doc.semester = body.semester || null;
  if (body.subject !== undefined) doc.subject = body.subject || null;
  if (body.topic !== undefined) doc.topic = body.topic;
  if (body.difficulty !== undefined) doc.difficulty = body.difficulty;
  if (body.status !== undefined) doc.status = body.status;
  doc.updatedBy = req.user._id;
  await doc.save();

  // Integrity: questions used in exams keep their id; score changes recorded by audit.
  await audit(req, 'question.update', 'Question', doc._id, `updated question ${doc._id}`);
  res.json({ success: true, data: { question: doc } });
});

// DELETE /api/questions/:id
const deleteQuestion = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.delete')) throw new ApiError(403, 'Missing permission: questions.delete');
  const doc = await Question.findById(req.params.id);
  if (!doc) throw new ApiError(404, 'Question not found');
  const used = await Exam.exists({ 'questions.question': doc._id, status: { $in: ['published', 'active', 'completed'] } });
  if (used) {
    throw new ApiError(409, 'Question is used in a published or completed exam and cannot be deleted');
  }
  await doc.deleteOne();
  await audit(req, 'question.delete', 'Question', req.params.id, 'deleted question');
  res.json({ success: true, message: 'Question deleted' });
});

// GET /api/questions/stats
const questionStats = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.view')) throw new ApiError(403, 'Missing permission: questions.view');
  const match = req.query.semester ? { semester: require('mongoose').Types.ObjectId.createFromHexString(req.query.semester) } : {};
  const [byStatus, bySubject, total] = await Promise.all([
    Question.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Question.aggregate([
      { $match: match },
      { $group: { _id: '$subject', count: { $sum: 1 } } },
      { $lookup: { from: 'subjects', localField: '_id', foreignField: '_id', as: 's' } },
      { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, subjectId: '$_id', subject: '$s.name', count: 1 } },
    ]),
    Question.countDocuments(match),
  ]);
  res.json({ success: true, data: { byStatus, bySubject, total } });
});

// POST /api/questions/detect-duplicates  { statement, options }
const detectDuplicate = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.view')) throw new ApiError(403, 'Missing permission: questions.view');
  const { statement } = req.body || {};
  if (!statement) throw new ApiError(400, 'statement required');
  const hash = Question.buildContentHash({ statement, options: [] });
  const dup = await Question.findOne({ contentHash: hash });
  res.json({ success: true, data: { duplicate: !!dup, id: dup ? dup._id : null } });
});

// ---- Import pipeline ----

// POST /api/question-imports/upload (multipart: file)
const uploadImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  if (!req.file) throw new ApiError(400, 'File is required');
  const ext = require('path').extname(req.file.originalname).toLowerCase().slice(1);
  if (!IMPORT_EXTS.includes(ext)) {
    fs.unlink(req.file.path, () => {});
    throw new ApiError(400, `Only ${IMPORT_EXTS.map((e) => `.${e}`).join(', ')} files are supported for question import`);
  }

  let text = '';
  let parseWarning = '';
  try {
    text = await extractText(req.file.path);
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    const batch = await QuestionImportBatch.create({
      fileName: req.file.originalname,
      fileType: ext,
      fileSize: req.file.size,
      status: 'failed',
      errorMessage: e.code === 'OCR_REQUIRED'
        ? e.message
        : `Text extraction failed: ${e.message}`,
      createdBy: req.user._id,
    });
    throw new ApiError(e.code === 'OCR_REQUIRED' ? 422 : 400, e.message, { batchId: batch._id });
  }

  const useAI = req.body && (req.body.useAI === true || req.body.useAI === 'true');
  let parsed;
  if (useAI) {
    try {
      const aiQuestions = await parseQuestionsWithAI(text);
      const mapped = aiQuestions.map((q, idx) => {
        const issues = [];
        const stmt = (q.statement || '').trim();
        if (!stmt) issues.push('empty_statement');
        if (!q.correctAnswers || !q.correctAnswers.length) issues.push('missing_answer');
        const options = Array.isArray(q.options) ? q.options.map((o, i) => ({
          key: String(o.key || String.fromCharCode(97 + i)).toLowerCase(),
          text: String(o.text || '').trim(),
        })) : [];
        const keys = options.map((o) => o.key);
        if (new Set(keys).size !== keys.length && keys.length) issues.push('duplicate_option_keys');
        if (['mcq', 'msq'].includes(q.type) && options.length < 2) issues.push('too_few_options');
        return {
          type: VALID_TYPES.includes(q.type) ? q.type : 'mcq',
          statement: stmt,
          options,
          correctAnswers: (q.correctAnswers || []).map((c) => String(c).toLowerCase()),
          explanation: String(q.explanation || ''),
          marks: Number(q.marks ?? 1),
          issues: [...new Set(issues)],
          duplicateOfIndex: null,
          sourceOrder: idx,
          ai: true,
        };
      });
      parsed = {
        questions: mapped,
        stats: {
          total: mapped.length,
          valid: mapped.filter((x) => !x.issues.length).length,
          needsReview: mapped.filter((x) => x.issues.length).length,
          missingAnswer: mapped.filter((x) => x.issues.some((i) => i === 'missing_answer')).length,
          duplicates: 0,
        },
      };
      parseWarning = mapped.length ? '' : 'No questions detected by AI.';
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      const batch = await QuestionImportBatch.create({
        fileName: req.file.originalname,
        fileType: ext,
        fileSize: req.file.size,
        status: 'failed',
        errorMessage: e.message,
        createdBy: req.user._id,
      });
      throw new ApiError(400, e.message, { batchId: batch._id });
    }
  } else {
    parsed = parseQuestions(text);
    parseWarning = parsed.warning;
  }

  // Enforce a configurable question-count limit so a huge document cannot
  // overwhelm the review screen or the database.
  const maxQuestions = env.MAX_IMPORT_QUESTIONS > 0 ? env.MAX_IMPORT_QUESTIONS : 0;
  if (maxQuestions && parsed.questions.length > maxQuestions) {
    parsed.questions = parsed.questions.slice(0, maxQuestions);
    parsed.stats.total = parsed.questions.length;
    parseWarning = `${parseWarning ? `${parseWarning} ` : ''}Only the first ${maxQuestions} questions were kept (import limit).`;
  }

  // duplicate detection against existing bank
  const hashes = parsed.questions.map((q) => Question.buildContentHash(q));
  const existing = hashes.length
    ? await Question.find({ contentHash: { $in: hashes } }).select('contentHash').lean()
    : [];
  const existingSet = new Set(existing.map((e) => e.contentHash));
  parsed.questions.forEach((q) => {
    const h = Question.buildContentHash(q);
    if (existingSet.has(h) && q.duplicateOfIndex === null) {
      q.duplicateOfIndex = -1; // -1 => exists in bank
      if (!q.issues.includes('duplicate_in_bank')) {
        q.issues.push('duplicate_in_bank');
        parsed.stats.needsReview += 1;
        if (q.correctAnswers.length) parsed.stats.valid -= 1;
      }
    }
  });
  parsed.stats.duplicates = parsed.questions.filter((q) => q.duplicateOfIndex !== null).length;

  fs.unlink(req.file.path, () => {});

  const batch = await QuestionImportBatch.create({
    fileName: req.file.originalname,
    fileType: ext,
    fileSize: req.file.size,
    status: 'parsed',
    stats: parsed.stats,
    questions: parsed.questions,
    createdBy: req.user._id,
  });
  await audit(req, 'question_import.upload', 'QuestionImportBatch', batch._id, `parsed ${parsed.stats.total} questions`);

  res.status(201).json({
    success: true,
    data: { batch, warning: parseWarning },
  });
});

// GET /api/question-imports
const listImports = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const [items, total] = await Promise.all([
    QuestionImportBatch.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    QuestionImportBatch.countDocuments(),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

// GET /api/question-imports/:id
const getImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const batch = await QuestionImportBatch.findById(req.params.id);
  if (!batch) throw new ApiError(404, 'Import batch not found');
  res.json({ success: true, data: { batch } });
});

// PUT /api/question-imports/:id  { questions, semester, subject }
const updateImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const batch = await QuestionImportBatch.findById(req.params.id);
  if (!batch) throw new ApiError(404, 'Import batch not found');
  if (batch.status === 'imported') throw new ApiError(409, 'Batch already imported');
  const { questions, semester, subject } = req.body || {};
  if (Array.isArray(questions)) {
    batch.questions = questions.map((q, i) => ({
      type: VALID_TYPES.includes(q.type) ? q.type : 'mcq',
      statement: String(q.statement || '').trim(),
      options: sanitizeOptions(Array.isArray(q.options) ? q.options : []),
      correctAnswers: (Array.isArray(q.correctAnswers) ? q.correctAnswers : []).map((c) => String(c).toLowerCase()),
      explanation: String(q.explanation || ''),
      marks: Number(q.marks ?? 1),
      issues: Array.isArray(q.issues) ? q.issues : [],
      duplicateOfIndex: q.duplicateOfIndex ?? null,
      sourceOrder: q.sourceOrder ?? i,
      ai: Boolean(q.ai),
    }));
    // recompute stats
    const qs = batch.questions;
    batch.stats = {
      ...batch.stats,
      total: qs.length,
      valid: qs.filter((q) => !q.issues.length).length,
      needsReview: qs.filter((q) => q.issues.length).length,
      missingAnswer: qs.filter((q) => !q.correctAnswers.length).length,
      duplicates: qs.filter((q) => q.duplicateOfIndex !== null).length,
    };
  }
  if (semester !== undefined) batch.semester = semester || null;
  if (subject !== undefined) batch.subject = subject || null;
  batch.status = 'reviewed';
  await batch.save();
  res.json({ success: true, data: { batch } });
});

// POST /api/question-imports/:id/confirm  { publish?: false }
const confirmImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const batch = await QuestionImportBatch.findById(req.params.id);
  if (!batch) throw new ApiError(404, 'Import batch not found');
  if (batch.status === 'imported') throw new ApiError(409, 'Batch already imported');
  const publish = req.body && req.body.publish === true;
  if (publish && !hasPermission(req.user, 'questions.publish')) {
    throw new ApiError(403, 'Missing permission: questions.publish');
  }
  const status = publish ? 'published' : 'draft';

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  for (const q of batch.questions) {
    if (!q.statement) {
      failed += 1;
      failures.push({ sourceOrder: q.sourceOrder, reason: 'empty statement' });
      continue;
    }
    if (q.duplicateOfIndex !== null) {
      skipped += 1;
      continue;
    }
    if (!q.correctAnswers.length && q.type !== 'descriptive') {
      skipped += 1;
      continue;
    }
    try {
      await Question.create({
        type: q.type,
        statement: q.statement,
        options: q.options,
        correctAnswers: q.correctAnswers,
        explanation: q.explanation,
        marks: q.marks || 1,
        semester: batch.semester,
        subject: batch.subject,
        status,
        sourceFileName: batch.fileName,
        importBatch: batch._id,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      });
      imported += 1;
    } catch (e) {
      failed += 1;
      failures.push({ sourceOrder: q.sourceOrder, reason: e.message });
    }
  }

  batch.status = 'imported';
  batch.importedAt = new Date();
  batch.stats = { ...batch.stats, imported, skipped, failed };
  await batch.save();
  await audit(req, 'question_import.confirm', 'QuestionImportBatch', batch._id, `imported ${imported} questions`);
  res.json({ success: true, data: { imported, skipped, failed, failures, batch } });
});

// DELETE /api/questions/imports/:id?deleteQuestions=true
const deleteImport = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const batch = await QuestionImportBatch.findById(req.params.id);
  if (!batch) throw new ApiError(404, 'Import batch not found');

  const deleteQuestions =
    req.query.deleteQuestions === 'true' || (req.body && req.body.deleteQuestions === true);

  let deletedQuestions = 0;
  let keptQuestions = 0;
  if (deleteQuestions) {
    const imported = await Question.find({ importBatch: batch._id }).select('_id').lean();
    for (const q of imported) {
      const used = await Exam.exists({
        'questions.question': q._id,
        status: { $in: ['published', 'active', 'completed'] },
      });
      if (used) {
        keptQuestions += 1;
        continue;
      }
      await Question.deleteOne({ _id: q._id });
      deletedQuestions += 1;
    }
  }

  await batch.deleteOne();
  await audit(
    req,
    'question_import.delete',
    'QuestionImportBatch',
    batch._id,
    `deleted import batch ${batch.fileName}${deleteQuestions ? ` and ${deletedQuestions} question(s)` : ''}`
  );
  res.json({ success: true, message: 'Import batch deleted', data: { deletedQuestions, keptQuestions } });
});

// DELETE /api/questions/imports/:id/questions/:index — remove one extracted draft question
const deleteBatchQuestion = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  const batch = await QuestionImportBatch.findById(req.params.id);
  if (!batch) throw new ApiError(404, 'Import batch not found');
  if (batch.status === 'imported') throw new ApiError(409, 'Batch already imported');
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= batch.questions.length) {
    throw new ApiError(400, 'Invalid question index');
  }
  batch.questions.splice(index, 1);
  const qs = batch.questions;
  batch.stats = {
    ...batch.stats,
    total: qs.length,
    valid: qs.filter((q) => !q.issues.length).length,
    needsReview: qs.filter((q) => q.issues.length).length,
    missingAnswer: qs.filter((q) => !q.correctAnswers.length).length,
    duplicates: qs.filter((q) => q.duplicateOfIndex !== null).length,
  };
  batch.status = 'reviewed';
  await batch.save();
  await audit(req, 'question_import.question_delete', 'QuestionImportBatch', batch._id, `removed draft question #${index}`);
  res.json({ success: true, data: { batch } });
});

// POST /api/questions/bulk-delete  { ids: [] }
const bulkDeleteQuestions = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.delete')) throw new ApiError(403, 'Missing permission: questions.delete');
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean).map(String) : [];
  if (!ids.length) throw new ApiError(400, 'No question ids provided');
  if (ids.length > 200) throw new ApiError(400, 'Too many questions in one request (max 200)');

  const protectedIds = await Exam.distinct('questions.question', {
    'questions.question': { $in: ids },
    status: { $in: ['published', 'active', 'completed'] },
  });
  const protectedSet = new Set(protectedIds.map(String));
  const deletable = ids.filter((id) => !protectedSet.has(id));
  let deleted = 0;
  if (deletable.length) {
    const r = await Question.deleteMany({ _id: { $in: deletable } });
    deleted = r.deletedCount || 0;
  }
  await audit(
    req,
    'question.bulk_delete',
    'Question',
    '',
    `deleted ${deleted} question(s), skipped ${ids.length - deleted} protected`
  );
  res.json({ success: true, data: { deleted, skipped: ids.length - deleted, protected: [...protectedSet] } });
});

// POST /api/questions/ai-parse (multipart: file)
const aiParseQuestions = asyncHandler(async (req, res) => {
  if (!hasPermission(req.user, 'questions.import')) throw new ApiError(403, 'Missing permission: questions.import');
  if (!req.file) throw new ApiError(400, 'File is required');
  const ext = require('path').extname(req.file.originalname).toLowerCase().slice(1);
  if (!IMPORT_EXTS.includes(ext)) {
    fs.unlink(req.file.path, () => {});
    throw new ApiError(400, `Only ${IMPORT_EXTS.map((e) => `.${e}`).join(', ')} files are supported`);
  }
  let text = '';
  try {
    text = await extractText(req.file.path);
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    throw new ApiError(e.code === 'OCR_REQUIRED' ? 422 : 400, e.message);
  }
  try {
    const aiQuestions = await parseQuestionsWithAI(text);
    const questions = aiQuestions.map((q, idx) => {
      const stmt = (q.statement || '').trim();
      const options = Array.isArray(q.options) ? q.options.map((o, i) => ({
        key: String(o.key || String.fromCharCode(97 + i)).toLowerCase(),
        text: String(o.text || '').trim(),
      })) : [];
      return {
        type: VALID_TYPES.includes(q.type) ? q.type : 'mcq',
        statement: stmt,
        options,
        correctAnswers: (q.correctAnswers || []).map((c) => String(c).toLowerCase()),
        explanation: String(q.explanation || ''),
        marks: Number(q.marks ?? 1),
        negativeMarks: Number(q.negativeMarks ?? 0),
      };
    });
    fs.unlink(req.file.path, () => {});
    res.json({ success: true, data: { questions } });
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    throw new ApiError(400, e.message);
  }
});

module.exports = {
  listQuestions,
  getQuestion,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  questionStats,
  detectDuplicate,
  aiParseQuestions,
  uploadImport,
  listImports,
  getImport,
  updateImport,
  confirmImport,
  deleteImport,
  deleteBatchQuestion,
  bulkDeleteQuestions,
};
