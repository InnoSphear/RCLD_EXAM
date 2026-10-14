#!/usr/bin/env node
/**
 * Development helper: starts an in-memory MongoDB when no local mongod is available,
 * writes the connection string into process.env, then boots the API server.
 * Production uses `npm start` with a real MONGODB_URI.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function hasLiveMongo(uri) {
  try {
    const mongoose = require('mongoose');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 1500 });
    await mongoose.disconnect();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rcld_exam_portal';
  let bootEnv = {};

  if (!(await hasLiveMongo(uri))) {
    console.log('[dev] No reachable MongoDB — starting in-memory MongoDB...');
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create({ instance: { port: 27017 } });
    const memUri = mongod.getUri('rcld_exam_portal');
    bootEnv.MONGODB_URI = memUri.replace(/\/\?/, '/rcld_exam_portal?');
    // prefer port 27017 instance uri
    bootEnv.MONGODB_URI = memUri;
    console.log('[dev] in-memory MongoDB ready at', memUri);
    process.on('SIGINT', async () => {
      await mongod.stop();
      process.exit(0);
    });
  } else {
    console.log('[dev] Using MongoDB at', uri.replace(/\/\/.*@/, '//***@'));
  }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'script.js')], {
    stdio: 'inherit',
    env: { ...process.env, ...bootEnv },
  });
  child.on('exit', (code) => process.exit(code || 0));
}

main().catch((e) => {
  console.error('[dev] failed:', e);
  process.exit(1);
});
