/**
 * Express application factory.
 *
 * Wires security headers, CORS, body parsing, cookies, the health check, the
 * rate limiter and the auth routes, then the 404 and error handlers. Kept free
 * of side effects so tests and `index.js` can build their own instance.
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { connectDb, ensureIndexes } from './config/db.js';
import { env } from './config/env.js';
import ApiError from './utils/ApiError.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import authRoutes from './routes/auth.js';

let databaseInitialization;

async function ensureDatabaseReady() {
  if (mongoose.connection.readyState === 1) return;
  if (!env.mongoUri) throw new Error('MONGODB_URI is not configured.');

  if (!databaseInitialization) {
    databaseInitialization = connectDb({ attempts: 1 })
      .then(ensureIndexes)
      .finally(() => {
        databaseInitialization = null;
      });
  }

  await databaseInitialization;
}

// `CLIENT_ORIGIN` is a comma-separated allow-list for browser origins.
const ALLOWED_ORIGINS = env.clientOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// In production the Google and Apple SDKs need their own script/frame origins;
// Tailwind and React inject inline styles. Keep this in sync with whatever
// serves the built SPA (the API only sets headers on its own responses).
function securityHeaders() {
  if (!env.isProduction) return helmet();

  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': [
          "'self'",
          'https://accounts.google.com',
          'https://www.gstatic.com',
          'https://appleid.cdn-apple.com',
        ],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https://www.svgrepo.com'],
        'connect-src': ["'self'", 'https://appleid.apple.com'],
        'frame-src': ['https://accounts.google.com', 'https://appleid.apple.com'],
      },
    },
  });
}

/**
 * Browsers attach `Origin` to cross-origin requests (and to same-origin POSTs).
 * Origins outside `CLIENT_ORIGIN` are rejected here, so they get a 403 instead
 * of the 500 that `cors` would produce when its callback receives an error.
 *
 * The request's own origin is always allowed: the Vercel setup serves the SPA and
 * the API from one domain, where every POST carries an `Origin` that can never
 * appear in `CLIENT_ORIGIN` (it is the deployment URL, not the dev server).
 */
function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  const host = req.headers.host;
  return Boolean(host) && origin === `${req.protocol}://${host}`;
}

function originGuard(req, _res, next) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(req, origin)) {
    return next(
      ApiError.forbidden('ORIGIN_NOT_ALLOWED', `Origin ${origin} is not allowed by CORS.`),
    );
  }
  next();
}

export function createApp() {
  const app = express();

  // Hiding the framework and trusting the proxy for rate limiting and cookies.
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(originGuard);
  app.use(
    cors({
      // Allow-list: the request origin is echoed back for matches only.
      origin: ALLOWED_ORIGINS,
      // Required for the cookie-based session endpoints.
      credentials: true,
    }),
  );
  // Small limits: these endpoints take short JSON bodies only.
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(cookieParser());

  // Liveness probe, also used by the smoke test.
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      database:
        mongoose.connection.readyState === 1
          ? 'connected'
          : mongoose.connection.readyState === 2
            ? 'connecting'
            : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use('/api', async (_req, _res, next) => {
    try {
      await ensureDatabaseReady();
      next();
    } catch (error) {
      console.error(`[api] database unavailable: ${error?.message ?? error}`);
      next(
        new ApiError(
          503,
          env.mongoUri ? 'DATABASE_UNAVAILABLE' : 'DATABASE_NOT_CONFIGURED',
          env.mongoUri
            ? 'Authentication is temporarily unavailable because the database connection failed.'
            : 'Authentication is temporarily unavailable because the database is not configured.',
        ),
      );
    }
  });

  // Everything under /api shares the global limit; auth routes add their own.
  app.use('/api', globalLimiter);
  app.use('/api/auth', authRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;