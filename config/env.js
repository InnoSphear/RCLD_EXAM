const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const REQUIRED_IN_PROD = ['MONGODB_URI', 'JWT_SECRET'];

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rcld_exam_portal',

  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || '12h',
  JWT_REFRESH_TTL_DAYS: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '7', 10),
  COOKIE_SECURE: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  DEFAULT_STUDENT_PASSWORD: process.env.DEFAULT_STUDENT_PASSWORD || '',
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '20', 10),
  MAX_IMPORT_PAGES: parseInt(process.env.MAX_IMPORT_PAGES || '100', 10),
  MAX_IMPORT_QUESTIONS: parseInt(process.env.MAX_IMPORT_QUESTIONS || '500', 10),
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
  AUTO_FINALIZE_INTERVAL_MS: parseInt(process.env.AUTO_FINALIZE_INTERVAL_MS || '30000', 10),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  CORS_ALLOW_ALL: bool(process.env.CORS_ALLOW_ALL, true),
};

function validateEnv() {
  const missing = REQUIRED_IN_PROD.filter((k) => !env[k]);
  if (env.NODE_ENV === 'production' && missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.NODE_ENV === 'production' && env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  if (!env.JWT_SECRET) {
    env.JWT_SECRET = 'dev_only_insecure_secret_change_me_0123456789';
    if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required');
  }
}

module.exports = { env, validateEnv };
