const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { env } = require('../config/env');
const { ApiError } = require('./error');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  students: ['.xlsx', '.csv'],
  questions: ['.pdf', '.docx', '.doc', '.txt', '.csv', '.xlsx'],
};

function makeUploader(kind) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
    },
  });
  const allowed = ALLOWED[kind] || ALLOWED.questions;
  return multer({
    storage,
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) return cb(new ApiError(400, `File type not allowed. Allowed: ${allowed.join(', ')}`));
      cb(null, true);
    },
  });
}

module.exports = { makeUploader, UPLOAD_DIR };
