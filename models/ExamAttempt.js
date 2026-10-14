const mongoose = require('mongoose');

const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'expired', 'auto_submitted'];

const answerSchema = new mongoose.Schema(
  {
    selected: { type: [String], default: [] },
    markedForReview: { type: Boolean, default: false },
    visited: { type: Boolean, default: false },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const attemptSchema = new mongoose.Schema(
  {
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    attemptNumber: { type: Number, default: 1, min: 1 },
    status: { type: String, enum: ATTEMPT_STATUSES, default: 'in_progress', index: true },
    // Authoritative server timing
    startedAt: { type: Date, default: null },
    deadline: { type: Date, default: null, index: true },
    submittedAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    // Snapshot of question order for this attempt (shuffle support)
    questionOrder: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // optionOrder: { <questionId>: [keys...] } snapshot for shuffled options
    optionOrder: { type: mongoose.Schema.Types.Mixed, default: {} },
    // answers keyed by questionId string
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    // cached counters (server computed)
    answeredCount: { type: Number, default: 0 },
    clientRevision: { type: Number, default: 0 },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

attemptSchema.index({ exam: 1, student: 1, attemptNumber: 1 }, { unique: true });
attemptSchema.index({ student: 1, status: 1 });

module.exports = mongoose.model('ExamAttempt', attemptSchema);
