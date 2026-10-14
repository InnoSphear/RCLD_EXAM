const router = require('express').Router();
const { authenticate, requirePermission, authorizeRoles } = require('../middlewares/auth');
const c = require('../controllers/resultController');
const ex = require('../controllers/exportController');
const { validate } = require('../middlewares/validate');
const { makeUploader } = require('../middlewares/upload');

router.use(authenticate);

router.get('/summary/exam/:examId', requirePermission('results.view'), c.examSummary);
router.get('/', authorizeRoles('superadmin', 'admin', 'subadmin', 'student'), c.listResults);
router.get('/:id', authorizeRoles('superadmin', 'admin', 'subadmin', 'student'), c.getResult);
router.patch('/:id/adjust', requirePermission('results.grade'), validate({ delta: 'required|number', reason: 'required|string' }), c.adjustResult);
router.post('/:id/release', requirePermission('results.view'), c.releaseResult);

module.exports = router;
