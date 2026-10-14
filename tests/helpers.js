/**
 * Test helper: boots the API on an ephemeral port against an in-memory MongoDB,
 * provides a small HTTP client with cookie/JWT handling, and seeds fixtures.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let mongod;
let server;
let baseUrl;
const mongoose = require('mongoose');

async function startTestServer() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  const { connectDB } = require('../config/db');
  await connectDB(uri);

  // seed permissions config env
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_0123456789abcdef0123456789abcdef';
  const { createApp } = require('../app');
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function stopTestServer() {
  if (server) await new Promise((r) => server.close(r));
  const { disconnectDB } = require('../config/db');
  await disconnectDB();
  if (mongod) await mongod.stop();
}

function client() {
  const jar = new Map();
  async function request(method, path, { body, headers = {}, raw = false, token } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(jar.size ? { Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    setCookie.forEach((c) => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx);
      const v = pair.slice(idx + 1);
      if (v === '' || c.includes('Expires=Thu, 01 Jan 1970')) jar.delete(k);
      else jar.set(k, v);
    });
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (raw) return { status: res.status, headers: res.headers, body: json, text };
    return { status: res.status, body: json };
  }
  return {
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    patch: (p, o) => request('PATCH', p, o),
    del: (p, o) => request('DELETE', p, o),
    jar,
    token: null,
    async login(email, password) {
      const r = await request('POST', '/api/auth/login', { body: { email, password } });
      if (r.status === 200 && r.body?.data?.accessToken) this.token = r.body.data.accessToken;
      return r;
    },
  };
}

async function makeUser({ name, email, password, role, permissions = [], semester = null, studentId }) {
  const User = require('../models/User');
  return User.create({
    name: name || `Test ${role}`,
    email: email || `${role}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    password: await bcrypt.hash(password || 'Passw0rd!123', 10),
    role,
    permissions: role === 'subadmin' ? permissions : undefined,
    semester,
    studentId: studentId || (role === 'student' ? `SID${Math.random().toString(36).slice(2, 8)}` : undefined),
    status: 'active',
  });
}

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

module.exports = { startTestServer, stopTestServer, client, makeUser, signToken };
