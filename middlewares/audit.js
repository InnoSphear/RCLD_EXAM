const AuditLog = require('../models/AuditLog');

async function audit(req, action, entity, entityId = '', summary = '', meta = {}) {
  try {
    await AuditLog.create({
      actor: req.user ? req.user._id : null,
      actorRole: req.user ? req.user.role : 'anonymous',
      action,
      entity,
      entityId: String(entityId),
      summary,
      meta,
      ip: req.ip || '',
    });
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}

module.exports = { audit };
