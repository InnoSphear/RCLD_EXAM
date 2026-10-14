const PERMISSIONS = [
  'dashboard.view',
  'students.view',
  'students.register',
  'students.edit',
  'students.import',
  'students.export',
  'questions.view',
  'questions.create',
  'questions.edit',
  'questions.delete',
  'questions.import',
  'questions.publish',
  'exams.view',
  'exams.create',
  'exams.schedule',
  'exams.publish',
  'exams.monitor',
  'results.view',
  'results.grade',
  'results.export',
  'semesters.manage',
  'subjects.manage',
  'subadmins.manage',
  'audit.view',
];

const ROLES = ['superadmin', 'admin', 'subadmin', 'student'];

const ROLE_LABELS = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  subadmin: 'Sub Admin',
  student: 'Student',
};

// Permissions granted automatically to each role (superadmin always gets everything).
const ROLE_PERMISSIONS = {
  superadmin: PERMISSIONS.slice(),
  admin: PERMISSIONS.filter((p) => p !== 'audit.view'),
  subadmin: [],
  student: [],
};

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin') return ROLE_PERMISSIONS.admin.includes(permission);
  if (user.role === 'subadmin') return Array.isArray(user.permissions) && user.permissions.includes(permission);
  return false;
}

module.exports = { PERMISSIONS, ROLES, ROLE_LABELS, ROLE_PERMISSIONS, hasPermission };
