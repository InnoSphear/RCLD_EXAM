const router = require('express').Router();
const { authenticate, requirePermission } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const c = require('../controllers/academicController');

router.use(authenticate);

router.get('/semesters', c.listSemesters);
router.post('/semesters', requirePermission('semesters.manage'), validate({ title: 'required|string|max:120', number: 'required|integer|min:1' }), c.createSemester);
router.patch('/semesters/:id', requirePermission('semesters.manage'), c.updateSemester);
router.delete('/semesters/:id', requirePermission('semesters.manage'), c.deleteSemester);

router.get('/subjects', c.listSubjects);
router.post('/subjects', requirePermission('subjects.manage'), validate({ name: 'required|string|max:120', semester: 'required|string' }), c.createSubject);
router.patch('/subjects/:id', requirePermission('subjects.manage'), c.updateSubject);
router.delete('/subjects/:id', requirePermission('subjects.manage'), c.deleteSubject);

module.exports = router;
