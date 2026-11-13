/**
 * Social sign-in verification.
 *
 * Google: the SPA sends an access token, which is checked against Google's
 * tokeninfo endpoint (including the audience) and then exchanged for the
 * profile. Apple: the SPA sends an identity token (JWT), verified locally
 * against Apple's JWKS with issuer, audience and algorithm pinned — no network
 * call to Apple is needed per sign-in.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import ApiError from '../utils/ApiError.js';

const GOOGLE_TOKENINFO_URL = env.googleTokenInfoUrl;
const GOOGLE_USERINFO_URL = env.googleUserInfoUrl;

// Cached JWKS for Apple, refreshed automatically when the keys rotate.
const appleJwks = createRemoteJWKSet(new URL(env.appleJwksUrl));

/** GET a JSON document with a timeout; returns null on a non-2xx response. */
async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError(502, 'OAUTH_PROVIDER_UNREACHABLE', 'Could not reach the OAuth provider.');
  }

  if (!response.ok) return null;
  return response.json();
}

/**
 * Verifies a Google OAuth access token issued to this application.
 * `tokeninfo` gives us the audience (client id), `userinfo` the profile.
 */
export async function verifyGoogleAccessToken(accessToken) {
  if (!env.googleClientId || env.googleClientId.startsWith('your_')) {
    throw new ApiError(
      503,
      'GOOGLE_NOT_CONFIGURED',
      'Google sign-in is not configured on the server (GOOGLE_CLIENT_ID).',
    );
  }

  const tokenInfo = await fetchJson(
    `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
  );

  if (!tokenInfo || tokenInfo.error) {
    throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google token is invalid or expired.');
  }

  if (tokenInfo.aud !== env.googleClientId) {
    throw ApiError.unauthorized(
      'GOOGLE_TOKEN_AUDIENCE_MISMATCH',
      'Google token was not issued for this application.',
    );
  }

  const profile = await fetchJson(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!profile?.sub) {
    throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google profile could not be read.');
  }

  const emailVerified =
    profile.email_verified === true || profile.email_verified === 'true';

  return {
    provider: 'google',
    id: profile.sub,
    email: profile.email ? String(profile.email).toLowerCase() : null,
    emailVerified,
    name: profile.name ?? null,
  };
}

/**
 * Apple only returns `name` on the very first authorisation, and as
 * `{ firstName, middleName, lastName }` rather than a single string.
 */
export function normalizeAppleName(name) {
  if (!name) return null;

  if (typeof name === 'string') {
    const trimmed = name.trim();
    return trimmed ? trimmed.slice(0, 80) : null;
  }

  const parts = [name.firstName, name.middleName, name.lastName]
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean);

  const joined = parts.join(' ');
  return joined ? joined.slice(0, 80) : null;
}

/**
 * Verifies an Apple identity token (a JWT) against Apple's published JWKS.
 */
export async function verifyAppleIdentityToken(identityToken) {
  const appleClientId = env.appleClientId;
  if (!appleClientId || appleClientId.startsWith('your_')) {
    throw new ApiError(
      503,
      'APPLE_NOT_CONFIGURED',
      'Apple sign-in is not configured on the server (APPLE_CLIENT_ID).',
    );
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: env.appleIssuer,
      audience: appleClientId,
      algorithms: ['RS256'],
    }));
  } catch {
    throw ApiError.unauthorized('INVALID_APPLE_TOKEN', 'Apple identity token is invalid.');
  }

  if (!payload?.sub) {
    throw ApiError.unauthorized('INVALID_APPLE_TOKEN', 'Apple token is missing a subject.');
  }

  const emailVerified =
    payload.email_verified === true || payload.email_verified === 'true';

  return {
    provider: 'apple',
    id: payload.sub,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    emailVerified,
    // Absent on every sign-in after the first one.
    name: null,
  };
}