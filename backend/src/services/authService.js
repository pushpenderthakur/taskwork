/**
 * Authentication use cases.
 *
 * Everything the routes need lives here: the OTP lifecycle (request, verify,
 * resend cooldown, attempt lockout), session issuing and rotation, and account
 * creation/linking for email, phone, Google and Apple sign-ins.
 */
import { Otp } from '../models/Otp.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import {
  compareOtp,
  generateOtpCode,
  hashOtp,
  maskIdentifier,
  normalizeIdentifier,
  otpExpiryDate,
} from '../utils/otp.js';
import { sendOtpEmail } from '../utils/mailer.js';
import { sendOtpSms } from '../utils/sms.js';
import { serializeUser } from '../utils/serialize.js';
import {
  generateRawToken,
  hashToken,
  signAccessToken,
} from '../utils/tokens.js';

const MAX_REFRESH_TOKENS = 10;

/** Builds the Mongo query for a destination on the given channel. */
function identifierQuery(method, identifier) {
  return method === 'email' ? { email: identifier } : { phone: identifier };
}

/** The flag that marks a channel as verified. */
function verifiedField(method) {
  return method === 'email' ? 'emailVerified' : 'phoneVerified';
}

/** How many wrong OTP guesses are still allowed. */
function remainingAttempts(record) {
  return Math.max(env.otpMaxAttempts - record.attempts, 0);
}

/** Sends the code over the channel's transport (email or SMS). */
async function dispatchOtp({ method, identifier, code }) {
  if (method === 'email') {
    return sendOtpEmail({ to: identifier, code, expiresInSeconds: env.otpTtlSeconds });
  }
  return sendOtpSms({ to: identifier, code, expiresInSeconds: env.otpTtlSeconds });
}

/**
 * Creates or replaces the live code for a destination and sends it.
 *
 * Rejects unknown accounts when `isLogin` is set, existing verified accounts
 * when registering, and resends inside the cooldown window.
 */
export async function sendOtp({ method, identifier, isLogin, name }) {
  const normalized = normalizeIdentifier(method, identifier);
  const query = identifierQuery(method, normalized);
  const user = await User.findOne(query).lean();
  const isVerified = Boolean(user?.[verifiedField(method)]);

  if (isLogin && !user) {
    throw ApiError.notFound(
      'ACCOUNT_NOT_FOUND',
      `No account is registered with this ${method}. Please register instead.`,
    );
  }

  if (!isLogin && isVerified) {
    throw ApiError.conflict(
      'ACCOUNT_EXISTS',
      `An account with this ${method} already exists. Please log in instead.`,
    );
  }

  const existing = await Otp.findOne({ method, identifier: normalized });

  if (existing?.lastSentAt) {
    const cooldownMs = env.otpResendCooldownSeconds * 1000;
    const elapsed = Date.now() - new Date(existing.lastSentAt).getTime();
    if (elapsed < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
      throw ApiError.tooManyRequests(`Please wait ${waitSeconds}s before requesting a new code.`);
    }
  }

  const code = generateOtpCode();
  const codeHash = await hashOtp(code);
  const update = {
    $set: {
      method,
      identifier: normalized,
      name: name?.trim() ? name.trim() : (existing?.name ?? null),
      codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: otpExpiryDate(env.otpTtlSeconds),
      lastSentAt: new Date(),
    },
  };

  try {
    await Otp.findOneAndUpdate(
      { method, identifier: normalized },
      update,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
  } catch (error) {
    // Two near-simultaneous requests (double click, two tabs) race on the unique
    // index: the loser re-runs as a plain update instead of failing the request.
    if (error?.code !== 11000) throw error;
    await Otp.updateOne({ method, identifier: normalized }, update);
  }

  let delivery;
  try {
    delivery = await dispatchOtp({ method, identifier: normalized, code });
  } catch (error) {
    // The code never reached the user, so drop it: leaving it behind would both
    // block an immediate retry and burn an undelivered OTP.
    await Otp.deleteOne({ method, identifier: normalized });
    throw error;
  }

  const result = {
    method,
    destination: maskIdentifier(method, normalized),
    expiresIn: env.otpTtlSeconds,
    resendAfter: env.otpResendCooldownSeconds,
  };

  // Without a real transport the code only exists in the server console, which
  // makes local development untestable. Hand it back explicitly, outside
  // production only, so the UI can show it. `ALLOW_DEV_OTP` opts in on a
  // deployment that has no mail provider yet (Vercel previews, demos).
  if (!delivery.delivered && (!env.isProduction || env.allowDevOtp)) {
    result.devCode = code;
  }

  return result;
}

/**
 * Checks a code, consumes it, and signs the user in.
 *
 * The record is marked used before the session is issued, so a code can never
 * be replayed even if two requests race.
 */
export async function verifyOtp({ method, identifier, otp, name, context } = {}) {
  const normalized = normalizeIdentifier(method, identifier);
  const record = await Otp.findOne({ method, identifier: normalized });

  if (!record) {
    throw ApiError.badRequest(
      'OTP_NOT_FOUND',
      'No active code for this destination. Please request a new one.',
    );
  }
  if (record.consumedAt) {
    throw ApiError.badRequest('OTP_ALREADY_USED', 'This code was already used. Request a new one.');
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    throw ApiError.badRequest('OTP_EXPIRED', 'This code has expired. Please request a new one.');
  }
  if (record.attempts >= env.otpMaxAttempts) {
    throw ApiError.tooManyRequests('Too many incorrect attempts. Please request a new code.');
  }

  const matches = await compareOtp(otp, record.codeHash);

  if (!matches) {
    record.attempts += 1;
    await record.save();
    throw ApiError.badRequest(
      'OTP_INVALID',
      `Incorrect code. ${remainingAttempts(record)} attempt(s) left.`,
    );
  }

  record.consumedAt = new Date();
  await record.save();

  const user = await findOrCreateUser({
    method,
    identifier: normalized,
    name: record.name ?? name,
  });

  const verifiedFieldForMethod = verifiedField(method);
  const changed = user[verifiedFieldForMethod] !== true;
  user[verifiedFieldForMethod] = true;
  if (record.name && !user.name) user.name = record.name.trim();

  const session = await issueSession(user, context);
  return { ...session, verified: changed };
}

/**
 * Returns the account for a verified destination, creating it on first sign in.
 *
 * Handles the race where two concurrent signups hit the unique index: the loser
 * re-reads the winner instead of failing the request.
 */
export async function findOrCreateUser({ method, identifier, name }) {
  const query = identifierQuery(method, identifier);
  const update = { [verifiedField(method)]: true };

  const existing = await User.findOne(query);
  if (existing) return existing;

  try {
    return await User.create({
      ...query,
      ...update,
      name: name?.trim() ? name.trim() : null,
    });
  } catch (error) {
    // Lost a race with a concurrent request: the unique index rejects the
    // duplicate, so re-read the winner instead of failing the sign in.
    if (error?.code === 11000) {
      const winner = await User.findOne(query);
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * Mints a refresh token, stores its hash with the request's device metadata and
 * returns the signed access token.
 *
 * Expired sessions are pruned on the way in; the oldest ones are dropped past
 * `MAX_REFRESH_TOKENS` so the array cannot grow without bound.
 */
export async function issueSession(user, { userAgent = null, ip = null } = {}) {
  const refreshToken = generateRawToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.refreshTokenTtlMs);

  user.refreshTokens = (user.refreshTokens ?? []).filter(
    // Expired tokens are useless; revoked ones are kept so a replay can be detected.
    (token) => new Date(token.expiresAt).getTime() > now.getTime(),
  );
  const tokenHash = hashToken(refreshToken);
  user.refreshTokens.push({
    tokenHash,
    userAgent: userAgent?.slice(0, 255) ?? null,
    ip,
    createdAt: now,
    expiresAt,
    revokedAt: null,
  });
  if (user.refreshTokens.length > MAX_REFRESH_TOKENS) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_REFRESH_TOKENS);
  }

  user.lastLoginAt = now;
  await user.save();

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: Math.round(env.refreshTokenTtlMs / 1000),
    user: serializeUser(user),
  };
}

/**
 * Rotates a refresh token: the presented token is revoked and a new one issued.
 *
 * Replaying an already-rotated token is treated as theft and revokes every
 * session in the family.
 */
export async function rotateSession(rawRefreshToken, { userAgent, ip } = {}) {
  if (!rawRefreshToken) {
    throw ApiError.unauthorized('MISSING_REFRESH_TOKEN', 'Refresh token is missing.');
  }

  const tokenHash = hashToken(rawRefreshToken);
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash });

  if (!user) {
    throw ApiError.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
  }

  const record = user.refreshTokens.find((token) => token.tokenHash === tokenHash);

  // A revoked token being replayed means it was stolen: kill every session.
  if (record?.revokedAt) {
    user.refreshTokens = [];
    await user.save();
    throw ApiError.unauthorized(
      'REFRESH_TOKEN_REUSED',
      'Refresh token reuse detected. Please sign in again.',
    );
  }

  if (!record || new Date(record.expiresAt).getTime() <= Date.now()) {
    user.refreshTokens = user.refreshTokens.filter((token) => token.tokenHash !== tokenHash);
    await user.save();
    throw ApiError.unauthorized('REFRESH_TOKEN_EXPIRED', 'Session expired. Please sign in again.');
  }

  record.revokedAt = new Date();
  return issueSession(user, { userAgent, ip });
}

/** Revokes one session. Returns false when the token is unknown or already dead. */
export async function revokeSession(rawRefreshToken) {
  if (!rawRefreshToken) return false;

  const tokenHash = hashToken(rawRefreshToken);
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash });
  if (!user) return false;

  const record = user.refreshTokens.find((token) => token.tokenHash === tokenHash);
  if (!record || record.revokedAt) return false;

  record.revokedAt = new Date();
  await user.save();
  return true;
}

/** Revokes every live session for a user ("sign out everywhere"). */
export async function revokeAllSessions(user) {
  const revoked = (user.refreshTokens ?? []).filter((token) => !token.revokedAt).length;
  if (revoked === 0) return 0;

  const now = new Date();
  user.refreshTokens.forEach((token) => {
    if (!token.revokedAt) token.revokedAt = now;
  });
  await user.save();
  return revoked;
}

/** Active sessions for the dashboard, with the current one flagged. */
export function listSessions(user, currentTokenHash) {
  return (user.refreshTokens ?? [])
    .filter((token) => !token.revokedAt && new Date(token.expiresAt).getTime() > Date.now())
    .map((token) => ({
      id: token.tokenHash.slice(0, 12),
      current: token.tokenHash === currentTokenHash,
      userAgent: token.userAgent ?? null,
      ip: token.ip ?? null,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
    }));
}

/**
 * Signs in with a social identity (Google or Apple).
 *
 * Looks the account up by provider id first, then by the verified email so an
 * existing email account is linked instead of duplicated. A lost create race is
 * resolved by re-reading and linking the winner.
 */
export async function signInWithProvider({ provider, profile, name }) {
  let user = await User.findOne({ [`providers.${provider}.id`]: profile.id });

  if (!user && profile.email) {
    user = await User.findOne({ email: profile.email });
  }

  if (user) {
    user.providers = user.providers ?? {};
    user.providers[provider] = {
      id: profile.id,
      email: profile.email ?? null,
      linkedAt: new Date(),
    };
    if (profile.email && !user.email) user.email = profile.email;
    if (profile.email && profile.emailVerified) user.emailVerified = true;
    if (profile.name && !user.name) user.name = profile.name;
    user.lastLoginAt = new Date();
    await user.save();
    return user;
  }

  try {
    return await User.create({
      name: profile.name ?? (name?.trim() ? name.trim() : null),
      email: profile.email ?? null,
      emailVerified: Boolean(profile.email && profile.emailVerified),
      providers: {
        [provider]: {
          id: profile.id,
          email: profile.email ?? null,
          linkedAt: new Date(),
        },
      },
      lastLoginAt: new Date(),
    });
  } catch (error) {
    // A concurrent request won the race: re-read the winner by provider id,
    // then by email, and link this provider to it instead of failing.
    if (error?.code === 11000) {
      const existing =
        (await User.findOne({ [`providers.${provider}.id`]: profile.id })) ??
        (profile.email ? await User.findOne({ email: profile.email }) : null);

      if (existing) {
        existing.providers = existing.providers ?? {};
        existing.providers[provider] = {
          id: profile.id,
          email: profile.email ?? null,
          linkedAt: new Date(),
        };
        if (profile.email && !existing.email) existing.email = profile.email;
        if (profile.email && profile.emailVerified) existing.emailVerified = true;
        if (profile.name && !existing.name) existing.name = profile.name;
        await existing.save();
        return existing;
      }
    }
    throw error;
  }
}

export async function getUserById(id) {
  return User.findById(id);
}

export { serializeUser };