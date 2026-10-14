const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { env } = require('../config/env');
const { ApiError, asyncHandler } = require('../middlewares/error');
const { signAccessToken, signRefreshToken, setAuthCookies, clearAuthCookies } = require('../middlewares/auth');
const { audit } = require('../middlewares/audit');

function sanitize(user) {
  return user.toSafeJSON();
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.validated || req.body;
  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+password');
  const genericError = new ApiError(401, 'Invalid email or password');
  if (!user) throw genericError;
  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) throw genericError;
  if (user.status !== 'active') throw new ApiError(403, 'Account is deactivated. Contact the administrator.');

  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  setAuthCookies(res, accessToken, refreshToken);
  await audit(req, 'auth.login', 'User', user._id, `${user.role} logged in`);
  res.json({ success: true, data: { user: sanitize(user), accessToken } });
});

const refresh = asyncHandler(async (req, res) => {
  const token = (req.cookies && req.cookies.refreshToken) || (req.body && req.body.refreshToken);
  if (!token) throw new ApiError(401, 'No session');
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw new ApiError(401, 'Session expired');
  }
  if (payload.typ !== 'refresh') throw new ApiError(401, 'Invalid session');
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') throw new ApiError(401, 'Account unavailable');
  const accessToken = signAccessToken(user);
  const newRefresh = signRefreshToken(user);
  setAuthCookies(res, accessToken, newRefresh);
  res.json({ success: true, data: { user: sanitize(user), accessToken } });
});

const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: sanitize(req.user) } });
});

const logout = asyncHandler(async (req, res) => {
  clearAuthCookies(res);
  if (req.user) await audit(req, 'auth.logout', 'User', req.user._id, 'logged out');
  res.json({ success: true, message: 'Logged out' });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.validated || req.body;
  const user = await User.findById(req.user._id).select('+password');
  const ok = await bcrypt.compare(String(currentPassword), user.password);
  if (!ok) throw new ApiError(400, 'Current password is incorrect');
  if (String(newPassword).length < 8) throw new ApiError(400, 'New password must be at least 8 characters');
  user.password = await bcrypt.hash(String(newPassword), 12);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  await user.save();
  await audit(req, 'auth.change_password', 'User', user._id, 'password changed');
  res.json({ success: true, message: 'Password changed successfully' });
});

module.exports = { login, refresh, me, logout, changePassword };
