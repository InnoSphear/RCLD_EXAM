const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Semester = require('../models/Semester');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { audit } = require('../middlewares/audit');
const { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } = require('../config/permissions');

const STAFF_ROLES = ['admin', 'subadmin'];

function hashPassword(pw) {
  return bcrypt.hash(pw, 12);
}

// GET /api/users?role=admin|subadmin&search=&page=&limit=
const listUsers = asyncHandler(async (req, res) => {
  const { role, search, page = 1, limit = 20, status } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    User.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: { items: items.map((u) => u.toSafeJSON()), total, page: pageNum, limit: limitNum },
  });
});

// POST /api/users  { name, email, password, role, permissions }
const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role, permissions = [], phone = '' } = req.validated || req.body;
  if (!STAFF_ROLES.includes(role)) throw new ApiError(400, 'Role must be admin or subadmin');
  if (req.user.role === 'admin' && role !== 'subadmin') throw new ApiError(403, 'Only Super Admin can create Admins');
  if (role === 'subadmin' && !hasPermission(req.user, 'subadmins.manage')) {
    throw new ApiError(403, 'Missing permission: subadmins.manage');
  }
  const cleanPerms = Array.isArray(permissions) ? permissions.filter((p) => PERMISSIONS.includes(p)) : [];
  const plainPassword = String(password || '').trim();
  if (!plainPassword) throw new ApiError(400, 'Password is required');
  const user = await User.create({
    name,
    email: String(email).toLowerCase().trim(),
    password: await hashPassword(plainPassword),
    role,
    phone,
    permissions: role === 'subadmin' ? cleanPerms : undefined,
    mustChangePassword: false,
    createdBy: req.user._id,
  });
  await audit(req, 'user.create', 'User', user._id, `created ${role} ${user.email}`, { role });
  res.status(201).json({ success: true, data: { user: user.toSafeJSON() } });
});

// PATCH /api/users/:id
const updateUser = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw new ApiError(404, 'User not found');

  if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
    throw new ApiError(403, 'You cannot modify a Super Admin account');
  }
  if (req.user.role === 'admin' && target.role === 'admin' && target._id.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'Admins cannot modify other Admin accounts');
  }

  const { name, email, phone, permissions, status, password, role } = req.body || {};

  if (role !== undefined) {
    if (req.user.role !== 'superadmin') throw new ApiError(403, 'Only Super Admin can change roles');
    if (target.role === 'superadmin') throw new ApiError(403, 'Super Admin role cannot be changed');
    if (!STAFF_ROLES.includes(role)) throw new ApiError(400, 'Role must be admin or subadmin');
    target.role = role;
  }
  if (name !== undefined) target.name = name;
  if (email !== undefined) target.email = String(email).toLowerCase().trim();
  if (phone !== undefined) target.phone = phone;
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) throw new ApiError(400, 'Invalid status');
    if (target.role === 'superadmin' && status !== 'active') throw new ApiError(403, 'Super Admin cannot be deactivated');
    if (req.user.role !== 'superadmin' && target.role === 'admin' && status !== 'active') {
      throw new ApiError(403, 'Only Super Admin can deactivate an Admin');
    }
    target.status = status;
  }
  if (permissions !== undefined) {
    if (req.user.role === 'admin' && !hasPermission(req.user, 'subadmins.manage')) {
      throw new ApiError(403, 'Missing permission: subadmins.manage');
    }
    if (target.role !== 'subadmin') throw new ApiError(400, 'Permissions only apply to Sub Admins');
    target.permissions = (Array.isArray(permissions) ? permissions : []).filter((p) => PERMISSIONS.includes(p));
  }
  if (password) {
    target.password = await hashPassword(password);
    target.mustChangePassword = false;
    target.passwordChangedAt = new Date();
  }
  await target.save();
  await audit(req, 'user.update', 'User', target._id, `updated ${target.email}`);
  res.json({ success: true, data: { user: target.toSafeJSON() } });
});

// DELETE /api/users/:id
const deleteUser = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role === 'superadmin') throw new ApiError(403, 'Super Admin cannot be deleted');
  if (req.user.role !== 'superadmin') throw new ApiError(403, 'Only Super Admin can delete accounts');
  await target.deleteOne();
  await audit(req, 'user.delete', 'User', target._id, `deleted ${target.email}`);
  res.json({ success: true, message: 'User deleted' });
});

// GET /api/users/permissions/catalog
const permissionCatalog = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { permissions: PERMISSIONS, roleDefaults: ROLE_PERMISSIONS } });
});

// GET /api/users/staff/available
const listStaff = asyncHandler(async (req, res) => {
  const staff = await User.find({ role: { $in: STAFF_ROLES } }).sort({ name: 1 });
  res.json({ success: true, data: { items: staff.map((u) => u.toSafeJSON()) } });
});

module.exports = { listUsers, createUser, updateUser, deleteUser, permissionCatalog, listStaff };
