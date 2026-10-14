const mongoose = require('mongoose');

const semesterSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    number: { type: Number, required: true, min: 1 },
    course: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

semesterSchema.index({ number: 1, course: 1 }, { unique: false });

module.exports = mongoose.model('Semester', semesterSchema);
