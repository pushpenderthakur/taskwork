/**
 * MongoDB connection lifecycle.
 *
 * `connectDb` retries because `docker compose up` and the API often start at the
 * same time: the first few attempts can fail while MongoDB is still booting.
 */
import mongoose from 'mongoose';
import { env } from './env.js';

// Strip unknown fields instead of silently dropping them from query results.
mongoose.set('strictQuery', true);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to MongoDB, retrying on failure.
 *
 * @param {object} [options]
 * @param {number} [options.attempts=10] - How many times to try before giving up.
 * @param {number} [options.delayMs=2000] - Pause between attempts.
 */
export async function connectDb({ attempts = 10, delayMs = 2000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoose.connect(env.mongoUri, {
        // Fail fast instead of buffering requests for the default 30 seconds.
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 10,
      });
      console.log(`[db] connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
      return mongoose.connection;
    } catch (error) {
      lastError = error;
      console.error(`[db] connection attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }

  // Every attempt failed: surface the last error to the caller.
  throw lastError;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Builds every model index (unique email/phone, TTL on OTPs).
 * Called once at boot so a fresh database gets its indexes immediately.
 */
export async function ensureIndexes() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}