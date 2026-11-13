/**
 * Local MongoDB for development.
 * Uses the mongodb-memory-server binary (downloads once on first run) and keeps
 * the data on disk in .data/mongo, so it behaves like a normal local database.
 *
 * Run with: npm run db:dev
 */
import fs from 'node:fs';
import net from 'node:net';
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
const HOST = '127.0.0.1';

/** True when something already accepts connections on the port. */
function isPortInUse(port, host, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// `db:dev` is idempotent: when a mongod is already serving this port (a previous
// run, or a manually started one) there is nothing to do, and starting a second
// instance on the same dbpath would only fail on the lock file.
if (await isPortInUse(PORT, HOST)) {
  console.log(`[db] MongoDB is already listening on ${HOST}:${PORT} - nothing to start.`);
  console.log('[db] stop that process first, or set MONGO_PORT, to run a second instance.');
  process.exit(0);
}

let mongod;
try {
  mongod = await MongoMemoryServer.create({
    instance: {
      port: PORT,
      ip: HOST,
      dbName: 'taskwork',
      dbPath: '.data/mongo',
      storageEngine: 'wiredTiger',
    },
  });
} catch (error) {
  const reason = String(error?.message ?? error).split('\n').find((line) => line.trim()) ?? '';
  console.error(`[db] could not start MongoDB on ${HOST}:${PORT}: ${reason}`);
  console.error(
    '[db] .data/mongo is probably locked by another mongod - stop it, or set MONGO_PORT to a free port.',
  );
  process.exit(1);
}

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