const mongoose = require('mongoose');

const batchQuestionSchema = new mongoose.Schema(
  {
    type: { type: String, default: 'mcq' },
    statement: { type: String, default: '' },
    options: { type: [{ key: String, text: String }], default: [] },
    correctAnswers: { type: [String], default: [] },
    explanation: { type: String, default: '' },
    marks: { type: Number, default: 1 },
    // parser flags
    issues: { type: [String], default: [] },
    duplicateOfIndex: { type: Number, default: null },
    sourceOrder: { type: Number, default: 0 },
    ai: { type: Boolean, default: false },
  },
  { _id: false }
);

const questionImportBatchSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'docx', 'doc', 'txt', 'csv', 'xlsx'], required: true },
    fileSize: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['uploaded', 'parsed', 'reviewed', 'imported', 'failed'],
      default: 'uploaded',
      index: true,
    },
    stats: {
      total: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      needsReview: { type: Number, default: 0 },
      missingAnswer: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      imported: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    questions: { type: [batchQuestionSchema], default: [] },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', default: null },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    errorMessage: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    importedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('QuestionImportBatch', questionImportBatchSchema);
