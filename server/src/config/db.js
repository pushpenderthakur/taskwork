import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectDb({ attempts = 10, delayMs = 2000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoose.connect(env.mongoUri, {
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

  throw lastError;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export async function ensureIndexes() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}