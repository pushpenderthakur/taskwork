import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Development needs a looser ceiling than production so the UI can be exercised
// repeatedly without waiting for the window to roll over.
const LIMITS = env.isProduction
  ? { global: 300, sendOtp: 10, verifyOtp: 30, oauth: 30 }
  : { global: 2000, sendOtp: 100, verifyOtp: 200, oauth: 100 };

function tooMany(message) {
  return {
    error: {
      code: 'RATE_LIMITED',
      message,
    },
  };
}

export const globalLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: LIMITS.global,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many requests. Please slow down.'),
});

export const sendOtpLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.sendOtp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many OTP requests. Please try again later.'),
});

export const verifyOtpLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.verifyOtp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many verification attempts. Please try again later.'),
});

export const oauthLimiter = rateLimit({
  windowMs: TEN_MINUTES,
  limit: LIMITS.oauth,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many social sign-in attempts. Please try again later.'),
});