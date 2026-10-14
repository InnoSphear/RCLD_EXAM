const mongoose = require('mongoose');

const QUESTION_TYPES = ['mcq', 'msq', 'tf', 'fill', 'assertion', 'descriptive'];

const optionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const questionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: QUESTION_TYPES, default: 'mcq', index: true },
    statement: { type: String, required: true, trim: true },
    options: { type: [optionSchema], default: [] },
    // For mcq/msq: option keys. For tf: 'true'/'false'. For fill/descriptive: text answers.
    correctAnswers: { type: [String], default: [] },
    explanation: { type: String, trim: true, default: '' },
    marks: { type: Number, default: 1, min: 0 },
    negativeMarks: { type: Number, default: 0, min: 0 },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', index: true },
    topic: { type: String, trim: true, default: '' },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    language: { type: String, default: 'en' },
    status: { type: String, enum: ['draft', 'review', 'published'], default: 'draft', index: true },
    sourceFileName: { type: String, default: '' },
    importBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionImportBatch', default: null, index: true },
    contentHash: { type: String, index: true, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

questionSchema.index({ semester: 1, subject: 1, status: 1 });
questionSchema.index({ statement: 'text', topic: 'text' });

function buildContentHash(doc) {
  const stmt = (doc.statement || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const opts = (doc.options || [])
    .map((o) => (typeof o === 'string' ? o : o.text || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
  return `${stmt}::${opts}`;
}

questionSchema.pre('save', function () {
  this.contentHash = buildContentHash(this);
});

questionSchema.statics.buildContentHash = buildContentHash;

module.exports = mongoose.model('Question', questionSchema);
