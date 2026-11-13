import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });

function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function readInt(name, fallback) {
  const value = Number.parseInt(readString(name, '') ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback) {
  const value = readString(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readSecret(name, { devFallbackLabel }) {
  const value = readString(name);
  if (value && value.replace(/_/g, '').toLowerCase() !== 'replacemewithalongrandomstring') {
    if (value.length >= 32) return value;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Missing or weak ${name}. Set a random value of at least 32 characters (e.g. \`openssl rand -hex 32\`).`,
    );
  }

  // Keep local development frictionless, but never silently reuse a secret across restarts.
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(
    `[config] ${name} is not set - using an ephemeral ${devFallbackLabel}. Tokens will not survive a restart. Set ${name} in server/.env.`,
  );
  return generated;
}

const nodeEnv = readString('NODE_ENV', 'development');
const port = readInt('PORT', 5000);

const GMAIL_SMTP_HOST = 'smtp.gmail.com';

function looksLikeGmail(address) {
  return /@(gmail|googlemail)\.com$/i.test(address);
}

// Filling in only SMTP_USER with a Gmail address is enough: host, port, TLS and
// the From header are then derived from it.
function resolveSmtp() {
  const host = readString('SMTP_HOST', '');
  const user = readString('SMTP_USER', '');
  const pass = readString('SMTP_PASS', '');
  const service = readString('SMTP_SERVICE', '');
  const gmail = !host && !service && looksLikeGmail(user);

  const configuredFrom = readString('MAIL_FROM', '');
  const fromIsPlaceholder =
    !configuredFrom ||
    configuredFrom.startsWith('your_') ||
    /taskwork\.local/i.test(configuredFrom);

  return {
    host: host || (gmail ? GMAIL_SMTP_HOST : ''),
    port: readInt('SMTP_PORT', gmail ? 465 : 587),
    secure: readBool('SMTP_SECURE', gmail),
    user,
    pass,
    service,
    from:
      fromIsPlaceholder && gmail
        ? `Taskwork <${user}>`
        : configuredFrom || 'Taskwork <no-reply@taskwork.local>',
  };
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port,
  serverRoot,
  mongoUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017/taskwork'),
  clientOrigin: readString('CLIENT_ORIGIN', 'http://localhost:5173'),
  accessTokenSecret: readSecret('JWT_ACCESS_SECRET', { devFallbackLabel: 'access token secret' }),
  refreshTokenSecret: readSecret('JWT_REFRESH_SECRET', { devFallbackLabel: 'refresh token secret' }),
  accessTokenTtl: readString('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtlDays: readInt('REFRESH_TOKEN_TTL_DAYS', 7),
  refreshTokenTtlMs: readInt('REFRESH_TOKEN_TTL_DAYS', 7) * 24 * 60 * 60 * 1000,
  otpTtlSeconds: readInt('OTP_TTL_SECONDS', 300),
  otpMaxAttempts: readInt('OTP_MAX_ATTEMPTS', 5),
  otpResendCooldownSeconds: readInt('OTP_RESEND_COOLDOWN_SECONDS', 30),
  googleClientId: readString('GOOGLE_CLIENT_ID', ''),
  appleClientId: readString('APPLE_CLIENT_ID', ''),
  // Overridable only so the identity token flow can be tested offline.
  appleIssuer: readString('APPLE_ISSUER', 'https://appleid.apple.com'),
  appleJwksUrl: readString('APPLE_JWKS_URL', 'https://appleid.apple.com/auth/keys'),
  smtp: resolveSmtp(),
};

export default env;