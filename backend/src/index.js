/**
 * Process entry point: connect to MongoDB, build the app and listen.
 *
 * Also owns graceful shutdown (SIGINT/SIGTERM) and turns a database outage into
 * an actionable message instead of a stack trace.
 */
import { createApp } from './app.js';
import { connectDb, disconnectDb, ensureIndexes } from './config/db.js';
import { env } from './config/env.js';
import { isEmailDeliveryConfigured } from './utils/mailer.js';

// Held so shutdown can close the listener.
let server;

/**
 * Reports settings that would make sign-in silently impossible (no transport in
 * production, dev OTP left on) or that simply disable a provider.
 */
function logConfigurationWarnings() {
  const emailReady = isEmailDeliveryConfigured();
  const smsReady = Boolean(env.sms.provider);

  if (env.isProduction && !emailReady && !smsReady) {
    console.warn(
      '[api] No email or SMS transport configured: OTP codes are logged but cannot reach anyone. Set SMTP_* in backend/.env (see .env.example), or ALLOW_DEV_OTP=true for a preview deployment.',
    );
  }

  if (env.isProduction && env.allowDevOtp) {
    console.warn(
      '[api] ALLOW_DEV_OTP is on: OTP codes are returned in API responses, so anyone who can call send-otp can sign in. Never use this on a public deployment.',
    );
  }

  if (!env.googleClientId || env.googleClientId.startsWith('your_')) {
    console.log('[api] Google sign-in is disabled (GOOGLE_CLIENT_ID is not set).');
  }
  if (!env.appleClientId || env.appleClientId.startsWith('your_')) {
    console.log('[api] Apple sign-in is disabled (APPLE_CLIENT_ID is not set).');
  }
}

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
    logConfigurationWarnings();
  });
}

/** Stops accepting connections, then closes the database connection. */
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

  // A connection error is the common case; point at the fix.
  const isDatabaseError =
    error?.name === 'MongooseServerSelectionError' || /mongodb/i.test(String(error?.message));
  if (isDatabaseError) {
    console.error(
      '[api] Could not reach MongoDB. Check MONGODB_URI in backend/.env, or run `docker compose up -d` from the repo root.',
    );
  }

  await disconnectDb().catch(() => {});
  process.exit(1);
});