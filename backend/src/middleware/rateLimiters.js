/**
 * Rate limits.
 *
 * The global limiter protects the whole API from floods; the per-route limiters
 * make brute force (OTP guesses, social token spam) expensive without hurting
 * normal use.
 */
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Development needs a looser ceiling than production so the UI can be exercised
// repeatedly without waiting for the window to roll over.
const LIMITS = env.isProduction
  ? { global: 300, sendOtp: 10, verifyOtp: 30, oauth: 30 }
  : { global: 2000, sendOtp: 100, verifyOtp: 200, oauth: 100 };

/** Error body used when a limit is hit. */
function tooMany(message) {
  return {
    error: {
      code: 'RATE_LIMITED',
      message,
    },
  };
}

/**
 * CORS preflights never reach a route handler, so counting them would let
 * browser-generated `OPTIONS` requests burn the quota of the request that
 * follows. Skipping them keeps the limits about real attempts.
 */
const skipPreflight = (req) => req.method === 'OPTIONS';

/** Every `/api` request. */
export const globalLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: LIMITS.global,
  skip: skipPreflight,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many requests. Please slow down.'),
});

/** `POST /api/auth/send-otp`: blocks code flooding and resend abuse. */
export const sendOtpLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.sendOtp,
  skip: skipPreflight,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many OTP requests. Please try again later.'),
});

/** `POST /api/auth/verify-otp`: caps guessing at 6 digit codes. */
export const verifyOtpLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.verifyOtp,
  skip: skipPreflight,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many verification attempts. Please try again later.'),
});

/** `POST /api/auth/google|apple`: caps token-guessing attempts. */
export const oauthLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.oauth,
  skip: skipPreflight,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many social sign-in attempts. Please try again later.'),
});