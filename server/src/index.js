import { createApp } from './app.js';
import { connectDb, disconnectDb, ensureIndexes } from './config/db.js';
import { env } from './config/env.js';

let server;

async function start() {
  await connectDb();
  await ensureIndexes();

  const app = createApp();
  server = app.listen(env.port, () => {
    console.log(`[api] listening on http://localhost:${env.port} (${env.nodeEnv})`);
    console.log(`[api] CORS origin: ${env.clientOrigin}`);
    if (!env.isProduction) {
      console.log('[api] OTP codes are printed to the server console in development.');
    }
  });
}

async function shutdown(signal) {
  console.log(`\n[api] ${signal} received, shutting down...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(async (error) => {
  console.error('[api] failed to start:', error?.message ?? error);

  const isDatabaseError =
    error?.name === 'MongooseServerSelectionError' || /mongodb/i.test(String(error?.message));
  if (isDatabaseError) {
    console.error(
      '[api] Could not reach MongoDB. Check MONGODB_URI in server/.env, or run `docker compose up -d` from the repo root.',
    );
  }

  await disconnectDb().catch(() => {});
  process.exit(1);
});