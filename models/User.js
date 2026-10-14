const mongoose = require('mongoose');
const { ROLES, PERMISSIONS } = require('../config/permissions');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    phone: { type: String, trim: true, default: '' },
    studentId: { type: String, trim: true, unique: true, sparse: true, index: true },
    rollNumber: { type: String, trim: true, default: '', index: true },
    course: { type: String, trim: true, default: '' },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', default: null, index: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    mustChangePassword: { type: Boolean, default: false },
    permissions: {
      type: [{ type: String, enum: PERMISSIONS }],
      default: undefined,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ name: 'text', email: 'text', studentId: 'text', rollNumber: 'text' });

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject({ virtuals: false });
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
