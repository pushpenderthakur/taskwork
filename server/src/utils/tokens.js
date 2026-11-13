import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const ISSUER = 'taskwork';
const AUDIENCE = 'taskwork-web';

export function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(user) {
  return jwt.sign({ sub: String(user._id) }, env.accessTokenSecret, {
    expiresIn: env.accessTokenTtl,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.accessTokenSecret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: env.refreshTokenTtlMs,
  };
}

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