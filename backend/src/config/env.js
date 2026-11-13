/**
 * Typed environment configuration.
 *
 * Reads `backend/.env` once at startup and exposes a frozen-ish `env` object so
 * the rest of the code never touches `process.env` directly. Secrets are
 * validated: production refuses to boot without strong JWT secrets, while
 * development generates ephemeral ones and warns.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

/** String value, `fallback` when unset or blank. */
function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

/** Integer value, `fallback` when unset or not a number. */
function readInt(name, fallback) {
  const value = Number.parseInt(readString(name, '') ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Boolean value (`1/true/yes/on`), `fallback` when unset. */
function readBool(name, fallback) {
  const value = readString(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Secret with a production guard.
 *
 * Values under 32 characters (and the placeholder) are rejected in production;
 * in development a random one is generated so the app still runs, at the cost of
 * sessions not surviving a restart.
 */
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
    `[config] ${name} is not set - using an ephemeral ${devFallbackLabel}. Tokens will not survive a restart. Set ${name} in backend/.env.`,
  );
  return generated;
}

/** Duration like `15m`, `900s` or `900` (seconds) in milliseconds. */
function readDurationMs(name, fallbackMs) {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(readString(name, ''));
  if (!match) return fallbackMs;

  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 's'];
  return Number(match[1]) * factor;
}

const nodeEnv = readString('NODE_ENV', 'development');
const port = readInt('PORT', 5000);

const GMAIL_SMTP_HOST = 'smtp.gmail.com';

/** Gmail addresses let us skip SMTP_HOST entirely. */
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

/** Public configuration read from the environment. */
export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port,
  backendRoot,
  mongoUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017/taskwork'),
  clientOrigin: readString('CLIENT_ORIGIN', 'http://localhost:5173'),
  accessTokenSecret: readSecret('JWT_ACCESS_SECRET', { devFallbackLabel: 'access token secret' }),
  refreshTokenSecret: readSecret('JWT_REFRESH_SECRET', { devFallbackLabel: 'refresh token secret' }),
  accessTokenTtl: readString('ACCESS_TOKEN_TTL', '15m'),
  // The access-token cookie has to expire with the token it carries.
  accessTokenTtlMs: readDurationMs('ACCESS_TOKEN_TTL', 15 * 60 * 1000),
  refreshTokenTtlDays: readInt('REFRESH_TOKEN_TTL_DAYS', 7),
  refreshTokenTtlMs: readInt('REFRESH_TOKEN_TTL_DAYS', 7) * 24 * 60 * 60 * 1000,
  otpTtlSeconds: readInt('OTP_TTL_SECONDS', 300),
  otpMaxAttempts: readInt('OTP_MAX_ATTEMPTS', 5),
  otpResendCooldownSeconds: readInt('OTP_RESEND_COOLDOWN_SECONDS', 30),
  // Escape hatch for preview deployments without a transport: echo the code in
  // the response even in production. Off unless explicitly enabled, and logged
  // loudly at boot, because it lets anyone who can call the API sign in.
  allowDevOtp: readBool('ALLOW_DEV_OTP', false),
  googleClientId: readString('GOOGLE_CLIENT_ID', ''),
  // Overridable only so the Google verification flow can be tested offline.
  googleTokenInfoUrl: readString(
    'GOOGLE_TOKENINFO_URL',
    'https://oauth2.googleapis.com/tokeninfo',
  ),
  googleUserInfoUrl: readString(
    'GOOGLE_USERINFO_URL',
    'https://www.googleapis.com/oauth2/v3/userinfo',
  ),
  appleClientId: readString('APPLE_CLIENT_ID', ''),
  // Overridable only so the identity token flow can be tested offline.
  appleIssuer: readString('APPLE_ISSUER', 'https://appleid.apple.com'),
  appleJwksUrl: readString('APPLE_JWKS_URL', 'https://appleid.apple.com/auth/keys'),
  sms: {
    provider: readString('SMS_PROVIDER', '').toLowerCase(),
    countryCode: readString('SMS_COUNTRY_CODE', '91'),
  },
  twilio: {
    accountSid: readString('TWILIO_ACCOUNT_SID', ''),
    authToken: readString('TWILIO_AUTH_TOKEN', ''),
    from: readString('TWILIO_FROM', ''),
    // Overridable only so the provider call can be tested offline.
    apiBase: readString('TWILIO_API_BASE', 'https://api.twilio.com/2010-04-01/Accounts'),
  },
  smtp: resolveSmtp(),
};

/** Default export for `import env from './config/env.js'`. */
export default env;