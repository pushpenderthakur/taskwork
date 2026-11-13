/**
 * Token helpers: opaque refresh tokens and signed access tokens.
 *
 * Access tokens are short-lived JWTs the SPA can read and send as a bearer
 * header. Refresh tokens are random 32-byte values; only their SHA-256 hash is
 * stored, so a database read cannot mint new sessions.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Bound into both token types and checked on verify.
const ISSUER = 'taskwork';
const AUDIENCE = 'taskwork-web';

/** 64 hex characters of CSPRNG output. */
export function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Deterministic, case-sensitive digest used for storage and lookup. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Signs an access token for a user document (only the id is embedded). */
export function signAccessToken(user) {
  return jwt.sign({ sub: String(user._id) }, env.accessTokenSecret, {
    expiresIn: env.accessTokenTtl,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/** Throws unless the token is a valid, unexpired token for this API. */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.accessTokenSecret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/**
 * Refresh cookie: scoped to the auth routes, httpOnly and (in production)
 * `secure` + `sameSite: 'none'` so it can be sent cross-site over HTTPS.
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: env.refreshTokenTtlMs,
  };
}

/** Access cookie mirrors the 15 minute access-token lifetime. */
export function accessCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000,
  };
}

export const tokenIssuer = ISSUER;
export const tokenAudience = AUDIENCE;