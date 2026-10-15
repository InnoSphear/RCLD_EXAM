const router = require('express').Router();
const { authenticate, requirePermission } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { makeUploader } = require('../middlewares/upload');
const c = require('../controllers/studentController');

router.use(authenticate);

const studentRules = {
  fullName: 'required|string|max:120',
  email: 'required|email',
  studentId: 'required|string|max:60',
  phone: 'string|max:20',
  rollNumber: 'string|max:40',
  course: 'string|max:80',
  semester: 'string',
  status: 'string|in:active,inactive',
  password: 'string',
};

router.get('/template', requirePermission('students.import'), c.downloadTemplate);
router.get('/export', requirePermission('students.export'), c.exportStudents);
router.post('/import/preview', requirePermission('students.import'), makeUploader('students').single('file'), c.previewImport);
router.post('/import/confirm', requirePermission('students.import'), c.confirmImport);
router.post('/bulk-status', requirePermission('students.edit'), c.bulkStatus);
router.post('/bulk-delete', requirePermission('students.delete'), c.bulkDeleteStudents);
router.post('/reset-password', requirePermission('students.edit'), c.resetPassword);
router.get('/', requirePermission('students.view'), c.listStudents);
router.post('/', requirePermission('students.register'), validate(studentRules), c.registerStudent);
router.get('/:id', requirePermission('students.view'), c.getStudent);
router.patch('/:id', requirePermission('students.edit'), c.updateStudent);
router.delete('/:id', requirePermission('students.delete'), c.deleteStudent);

module.exports = router;
