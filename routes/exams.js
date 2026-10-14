const router = require('express').Router();
const { authenticate, requirePermission, authorizeRoles } = require('../middlewares/auth');
const c = require('../controllers/examController');

router.use(authenticate);

router.get('/preview-questions', authorizeRoles('superadmin', 'admin', 'subadmin'), c.previewQuestions);
router.get('/', authorizeRoles('superadmin', 'admin', 'subadmin'), c.listExams);
router.post('/', requirePermission('exams.create'), c.createExam);
router.get('/:id', authorizeRoles('superadmin', 'admin', 'subadmin'), c.getExam);
router.put('/:id', requirePermission('exams.create'), c.updateExam);
router.post('/:id/status', authorizeRoles('superadmin', 'admin', 'subadmin'), c.setStatus);
router.post('/:id/release-results', requirePermission('exams.publish'), c.releaseResults);
router.get('/:id/monitor', requirePermission('exams.monitor'), c.monitor);
router.get('/:id/attempts', requirePermission('exams.monitor'), c.listAttempts);

module.exports = router;
