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

  app.use(cors({ origin: true, credentials: true }));

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
