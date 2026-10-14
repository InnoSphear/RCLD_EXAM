const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { ApiError, asyncHandler } = require('./error');
const { hasPermission } = require('../config/permissions');
const User = require('../models/User');

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies && req.cookies.accessToken) return req.cookies.accessToken;
  return null;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, v: user.passwordChangedAt ? new Date(user.passwordChangedAt).getTime() : 0 },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user._id.toString(), typ: 'refresh' }, env.JWT_SECRET, {
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
  });
}

function setAuthCookies(res, accessToken, refreshToken) {
  const common = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
  res.cookie('accessToken', accessToken, { ...common, maxAge: 12 * 60 * 60 * 1000 });
  res.cookie('refreshToken', refreshToken, { ...common, maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000, path: '/api/auth' });
}

function clearAuthCookies(res) {
  res.clearCookie('accessToken', { path: '/' });
  res.clearCookie('refreshToken', { path: '/api/auth' });
}

const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw new ApiError(401, 'Authentication required');
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (e) {
    throw new ApiError(401, e.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid session');
  }
  if (payload.typ === 'refresh') throw new ApiError(401, 'Invalid session');
  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError(401, 'Account not found');
  if (user.status !== 'active') throw new ApiError(403, 'Account is deactivated');
  req.user = user;
  next();
});

// Authenticated, but allows mustChangePassword users only through change-password route
const requirePasswordChanged = (req, res, next) => {
  if (req.user && req.user.mustChangePassword && !req.originalUrl.includes('/change-password')) {
    return next(new ApiError(403, 'Password change required', { mustChangePassword: true }));
  }
  next();
};

const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }
  next();
};

const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (!hasPermission(req.user, permission)) {
    return next(new ApiError(403, `Missing permission: ${permission}`));
  }
  next();
};

module.exports = {
  authenticate,
  authorizeRoles,
  requirePermission,
  requirePasswordChanged,
  signAccessToken,
  signRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  extractToken,
};
