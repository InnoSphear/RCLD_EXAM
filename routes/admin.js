const router = require('express').Router();
const { authenticate, requirePermission, authorizeRoles } = require('../middlewares/auth');
const c = require('../controllers/adminController');
const { makeUploader } = require('../middlewares/upload');

router.use(authenticate);

router.get('/dashboard', authorizeRoles('superadmin', 'admin', 'subadmin'), c.adminDashboard);
router.get('/audit-logs', requirePermission('audit.view'), c.auditLogs);
router.get('/stats/overview', authorizeRoles('superadmin', 'admin', 'subadmin'), c.overviewStats);

module.exports = router;
