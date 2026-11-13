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
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import authRoutes from './routes/auth.js';

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

export function createApp() {
  const app = express();

  // Hiding the framework and trusting the proxy for rate limiting and cookies.
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / curl requests arrive without an Origin header.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      },
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

  // Everything under /api shares the global limit; auth routes add their own.
  app.use('/api', globalLimiter);
  app.use('/api/auth', authRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;