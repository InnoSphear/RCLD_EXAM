const router = require('express').Router();
const { authenticate, requirePermission } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { makeUploader } = require('../middlewares/upload');
const { importLimiter } = require('../middlewares/rateLimit');
const c = require('../controllers/questionController');

router.use(authenticate);

router.get('/stats', requirePermission('questions.view'), c.questionStats);
router.post('/detect-duplicate', requirePermission('questions.view'), c.detectDuplicate);
router.post('/bulk-delete', requirePermission('questions.delete'), c.bulkDeleteQuestions);
router.post('/ai-parse', requirePermission('questions.import'), importLimiter, makeUploader('questions').single('file'), c.aiParseQuestions);

// import sub-routes
router.post('/imports/upload', requirePermission('questions.import'), importLimiter, makeUploader('questions').single('file'), c.uploadImport);
router.get('/imports', requirePermission('questions.import'), c.listImports);
router.get('/imports/:id', requirePermission('questions.import'), c.getImport);
router.put('/imports/:id', requirePermission('questions.import'), c.updateImport);
router.post('/imports/:id/confirm', requirePermission('questions.import'), c.confirmImport);
router.delete('/imports/:id/questions/:index', requirePermission('questions.import'), c.deleteBatchQuestion);
router.delete('/imports/:id', requirePermission('questions.import'), c.deleteImport);

router.get('/', requirePermission('questions.view'), c.listQuestions);
router.post('/', requirePermission('questions.create'), c.createQuestion);
router.get('/:id', requirePermission('questions.view'), c.getQuestion);
router.patch('/:id', requirePermission('questions.edit'), c.updateQuestion);
router.delete('/:id', requirePermission('questions.delete'), c.deleteQuestion);

module.exports = router;
