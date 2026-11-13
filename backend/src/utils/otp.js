/**
 * OTP primitives: generation, hashing, normalisation and masking.
 *
 * Codes are 6 digits and compared against a bcrypt hash, so a database leak
 * does not reveal live codes.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const OTP_LENGTH = 6;
const BCRYPT_ROUNDS = 10;

/**
 * Uniformly distributed 6 digit code, leading zeros included.
 *
 * `randomInt` draws from the platform CSPRNG: a predictable code would make the
 * 5-attempt lockout and the 10 minute TTL the only thing standing between an
 * attacker and an account.
 */
export function generateOtpCode() {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
}

export function hashOtp(code) {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

export function compareOtp(code, hash) {
  return bcrypt.compare(code, hash);
}

/**
 * Canonical form of a destination: emails are lower-cased and trimmed, phone
 * numbers keep only digits (last 10, so country codes can be pasted in).
 */
export function normalizeIdentifier(method, identifier) {
  const value = String(identifier ?? '').trim();
  if (method === 'email') return value.toLowerCase();
  return value.replace(/\D/g, '').slice(-10);
}

/** Safe version for logs and API responses, e.g. `ab****@example.com`. */
export function maskIdentifier(method, identifier) {
  if (method === 'email') {
    const [local, domain] = identifier.split('@');
    if (!domain) return identifier;
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
  }
  // The stored form is the last 10 digits, so the country code comes from config
  // rather than being hardcoded to +91.
  return `+${env.sms.countryCode} ${identifier.slice(0, 2)}****${identifier.slice(-2)}`;
}

/** Absolute expiry for a code with the given time to live. */
export function otpExpiryDate(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000);
}