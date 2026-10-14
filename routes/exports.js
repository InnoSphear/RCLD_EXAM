const router = require('express').Router();
const { authenticate, requirePermission } = require('../middlewares/auth');
const ex = require('../controllers/exportController');

router.use(authenticate);

router.get('/results', requirePermission('results.export'), ex.exportResults);
router.get('/attempts', requirePermission('results.export'), ex.exportAttempts);

module.exports = router;
