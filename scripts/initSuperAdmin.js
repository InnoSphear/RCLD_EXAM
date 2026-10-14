#!/usr/bin/env node
/**
 * Super Admin bootstrap.
 * Usage:
 *   node scripts/initSuperAdmin.js --email=admin@example.com --name="Site Admin" [--password=...] 
 *   node scripts/initSuperAdmin.js            (uses SUPER_ADMIN_* env vars or generates a password)
 *
 * Never hardcodes a production password. In production, pass a strong password
 * via environment variable or the --password flag (or use the generated one printed once).
 */
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

function arg(name, dflt = null) {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : dflt;
}

async function main() {
  const email = (arg('email') || process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  const name = arg('name') || process.env.SUPER_ADMIN_NAME || 'Super Admin';
  let password = arg('password') || process.env.SUPER_ADMIN_PASSWORD || '';
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generated = true;
  }
  if (!email) {
    console.error('Email required. Use --email=you@example.com or SUPER_ADMIN_EMAIL env var.');
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Invalid email address.');
    process.exit(1);
  }

  await connectDB();
  try {
    const existing = await User.findOne({ email });
    if (existing) {
      if (existing.role === 'superadmin') {
        console.log(`Super Admin already exists: ${email} (no changes made)`);
      } else {
        existing.role = 'superadmin';
        existing.status = 'active';
        if (arg('password') || process.env.SUPER_ADMIN_PASSWORD) {
          existing.password = await bcrypt.hash(password, 12);
          existing.mustChangePassword = true;
          existing.passwordChangedAt = new Date();
        }
        await existing.save();
        console.log(`Promoted existing user ${email} to superadmin.`);
      }
      process.exit(0);
    }
    await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 12),
      role: 'superadmin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await AuditLog.create({
      actor: null,
      actorRole: 'system',
      action: 'superadmin.bootstrap',
      entity: 'User',
      summary: `Super Admin created: ${email}`,
    });
    console.log(`Super Admin created: ${email}`);
    if (generated) {
      console.log('\nOne-time generated password (store it securely now, it will NOT be shown again):\n');
      console.log(`  ${password}\n`);
      console.log('You will be required to change it on first login.');
    } else {
      console.log('Password set from provided value. Change it on first login.');
    }
  } finally {
    await disconnectDB();
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
