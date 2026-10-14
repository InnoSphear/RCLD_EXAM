const { env, validateEnv } = require('./config/env');
const { connectDB } = require('./config/db');
const { createApp } = require('./app');
const { autoFinalizeExpired } = require('./controllers/attemptController');

async function main() {
  validateEnv();
  await connectDB();

  const app = createApp();

  // background auto-finalizer for expired attempts
  const timer = setInterval(() => {
    autoFinalizeExpired().catch((e) => console.error('[auto-finalize]', e.message));
  }, env.AUTO_FINALIZE_INTERVAL_MS);
  timer.unref();

  const server = app.listen(env.PORT, () => {
    console.log(`[server] RCLD exam portal API listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async () => {
    console.log('[server] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] failed to start:', err.message);
  process.exit(1);
});
