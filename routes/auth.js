const router = require('express').Router();
const { validate } = require('../middlewares/validate');
const { authenticate, requirePasswordChanged } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');
const c = require('../controllers/authController');

router.post('/login', authLimiter, validate({ email: 'required|email', password: 'required|string' }), c.login);
router.post('/refresh', c.refresh);
router.get('/me', authenticate, c.me);
router.post('/logout', authenticate, c.logout);
router.post(
  '/change-password',
  authenticate,
  validate({ currentPassword: 'required|string', newPassword: 'required|string|min:8' }),
  c.changePassword
);

module.exports = router;
