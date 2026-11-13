/**
 * Typed access to the environment variables that are safe to expose.
 *
 * Both provider IDs treat the `.env.example` placeholder (`your_...`) as
 * "not configured", so copying the example file never enables a broken button.
 */
const rawGoogleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const rawAppleClientId = import.meta.env.VITE_APPLE_CLIENT_ID ?? '';

export const GOOGLE_CLIENT_ID = rawGoogleClientId.trim();
export const APPLE_CLIENT_ID = rawAppleClientId.trim();

export const isGoogleConfigured =
  GOOGLE_CLIENT_ID.length > 0 && !GOOGLE_CLIENT_ID.startsWith('your_');

export const isAppleConfigured =
  APPLE_CLIENT_ID.length > 0 && !APPLE_CLIENT_ID.startsWith('your_');

/**
 * Base URL of the auth API.
 *
 * Empty means "mock mode" (simulated round trip) in development. A production
 * build always needs the real API, so it defaults to `/api/auth` on the current
 * origin — the Vercel setup serves both from one domain. Without that default a
 * forgotten `VITE_API_BASE_URL` would silently disable sign-in.
 */
const configuredApiBase = (import.meta.env.VITE_API_BASE_URL ?? '').trim();

export const API_URL = configuredApiBase || (import.meta.env.PROD ? '/api/auth' : '');