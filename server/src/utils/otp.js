import bcrypt from 'bcryptjs';

const OTP_LENGTH = 6;
const BCRYPT_ROUNDS = 10;

export function generateOtpCode() {
  // Uniformly distributed 6 digit code, including leading zeros.
  const max = 10 ** OTP_LENGTH;
  const value = Math.floor(Math.random() * max);
  return value.toString().padStart(OTP_LENGTH, '0');
}

export async function hashOtp(code) {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

export async function compareOtp(code, hash) {
  return bcrypt.compare(code, hash);
}

export function normalizeIdentifier(method, identifier) {
  const value = String(identifier ?? '').trim();
  if (method === 'email') return value.toLowerCase();
  return value.replace(/\D/g, '').slice(-10);
}

export function maskIdentifier(method, identifier) {
  if (method === 'email') {
    const [local, domain] = identifier.split('@');
    if (!domain) return identifier;
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
  }
  return `+91 ${identifier.slice(0, 2)}****${identifier.slice(-2)}`;
}

export function otpExpiryDate(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000);
}