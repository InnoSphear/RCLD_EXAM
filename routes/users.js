const router = require('express').Router();
const { authenticate, requirePermission, authorizeRoles } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const c = require('../controllers/userController');

router.use(authenticate);
router.get('/permissions/catalog', requirePermission('subadmins.manage'), c.permissionCatalog);
router.get('/staff', authorizeRoles('superadmin', 'admin'), c.listStaff);
router.get('/', authorizeRoles('superadmin', 'admin'), c.listUsers);
router.post(
  '/',
  authorizeRoles('superadmin', 'admin'),
  validate({ name: 'required|string|max:120', email: 'required|email', password: 'required|string|min:8', role: 'required|string|in:admin,subadmin' }),
  c.createUser
);
router.patch('/:id', authorizeRoles('superadmin', 'admin'), c.updateUser);
router.delete('/:id', authorizeRoles('superadmin'), c.deleteUser);

module.exports = router;
