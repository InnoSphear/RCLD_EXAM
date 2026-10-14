const mongoose = require('mongoose');

const evaluationItemSchema = new mongoose.Schema(
  {
    question: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
    selected: { type: [String], default: [] },
    correct: { type: [String], default: [] },
    isCorrect: { type: Boolean, default: false },
    awarded: { type: Number, default: 0 },
  },
  { _id: false }
);

const resultSchema = new mongoose.Schema(
  {
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
    attempt: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true, unique: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', default: null, index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null, index: true },
    status: { type: String, enum: ['pending', 'evaluated', 'released'], default: 'evaluated', index: true },
    totalQuestions: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
    incorrect: { type: Number, default: 0 },
    unanswered: { type: Number, default: 0 },
    marksObtained: { type: Number, default: 0 },
    maxMarks: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    passStatus: { type: String, enum: ['none', 'pass', 'fail'], default: 'none' },
    evaluation: { type: [evaluationItemSchema], default: [] },
    submittedAt: { type: Date, default: null },
    evaluatedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    manualAdjustments: {
      type: [
        {
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          at: { type: Date, default: Date.now },
          reason: { type: String, default: '' },
          delta: { type: Number, default: 0 },
          previousMarks: { type: Number, default: 0 },
          newMarks: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

resultSchema.index({ semester: 1, subject: 1, exam: 1 });
resultSchema.index({ student: 1, exam: 1 });

module.exports = mongoose.model('Result', resultSchema);
