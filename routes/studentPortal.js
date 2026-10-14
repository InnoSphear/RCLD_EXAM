const router = require('express').Router();
const { authenticate, authorizeRoles } = require('../middlewares/auth');
const c = require('../controllers/studentPortalController');

router.use(authenticate, authorizeRoles('student', 'superadmin', 'admin'));

router.get('/dashboard', c.dashboard);
router.get('/semesters/:id/exams', c.semesterExams);
router.get('/results', c.myResults);

module.exports = router;
