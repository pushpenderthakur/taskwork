/**
 * Local MongoDB for development.
 * Uses the mongodb-memory-server binary (downloads once on first run) and keeps
 * the data on disk in .data/mongo, so it behaves like a normal local database.
 *
 * Run with: npm run db:dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Reuse the binary that mongodb-memory-server already downloaded instead of
// pulling the full ~780MB distribution again.
const cacheDir = path.join(process.cwd(), 'node_modules', '.cache', 'mongodb-memory-server');
try {
  const cached = fs.readdirSync(cacheDir).find((name) => /^mongod-.*\.exe$/.test(name));
  if (cached) {
    process.env.MONGOMS_SYSTEM_BINARY = path.join(cacheDir, cached);
  }
} catch {
  // No cache yet - let mongodb-memory-server download the binary.
}

const PORT = Number(process.env.MONGO_PORT ?? 27017);

const mongod = await MongoMemoryServer.create({
  instance: {
    port: PORT,
    ip: '127.0.0.1',
    dbName: 'taskwork',
    dbPath: '.data/mongo',
    storageEngine: 'wiredTiger',
  },
});

const uri = mongod.getUri('taskwork');
console.log(`[db] local MongoDB ready at ${uri}`);
console.log(`[db] data directory: .data/mongo`);
console.log('[db] press Ctrl+C to stop');

function shutdown() {
  mongod.stop().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {}, 1 << 30);