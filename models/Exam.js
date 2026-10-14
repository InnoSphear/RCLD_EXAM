const mongoose = require('mongoose');

const EXAM_STATUSES = ['draft', 'scheduled', 'published', 'active', 'completed', 'cancelled'];

const examQuestionSchema = new mongoose.Schema(
  {
    question: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    marks: { type: Number, required: true, min: 0 },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const examSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    instructions: { type: String, default: '' },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, index: true },
    course: { type: String, default: '' },
    questions: { type: [examQuestionSchema], default: [] },
    questionCount: { type: Number, default: 0 },
    totalMarks: { type: Number, default: 0 },
    durationMinutes: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true, index: true },
    endsAt: { type: Date, required: true, index: true },
    maxAttempts: { type: Number, default: 1, min: 1 },
    negativeMarking: { type: Boolean, default: false },
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    // immediate | after_deadline | manual
    resultRelease: { type: String, enum: ['immediate', 'after_deadline', 'manual'], default: 'immediate' },
    resultsReleased: { type: Boolean, default: false },
    status: { type: String, enum: EXAM_STATUSES, default: 'draft', index: true },
    allowMultipleAttempts: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

examSchema.index({ semester: 1, subject: 1, status: 1 });

examSchema.pre('validate', function () {
  if (this.questions && this.questions.length) {
    this.questionCount = this.questions.length;
    this.totalMarks = this.questions.reduce((s, q) => s + (q.marks || 0), 0);
  }
});

module.exports = mongoose.model('Exam', examSchema);
