const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { env } = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middlewares/error');
const { apiLimiter } = require('./middlewares/rateLimit');

function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: false, // SPA + Vite dev; tighten with build hashes in production if desired
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  const allowedOrigins = [
    env.FRONTEND_URL,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ].filter(Boolean);

  app.use(
    cors({
      // Reflect any origin when CORS_ALLOW_ALL is enabled (default), so every
      // frontend URL is accepted while still supporting credentialed requests.
      origin(origin, cb) {
        if (!origin || env.CORS_ALLOW_ALL || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.get("/word", (req,res)=>{
    res.send("Hello I am working properly");
  })

  app.get("/", (req,res)=>{
    res.send("Server Is Alive......!!!!!! ")
  })

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  app.use('/api', apiLimiter);
  app.use('/api', routes);

  // Serve frontend build if present (production single-server deployment)
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(distDir, 'index.html'), (err) => err && next());
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
