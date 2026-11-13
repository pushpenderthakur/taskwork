const rawGoogleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const rawAppleClientId = import.meta.env.VITE_APPLE_CLIENT_ID ?? '';

export const GOOGLE_CLIENT_ID = rawGoogleClientId.trim();
export const APPLE_CLIENT_ID = rawAppleClientId.trim();

export const isGoogleConfigured =
  GOOGLE_CLIENT_ID.length > 0 && !GOOGLE_CLIENT_ID.startsWith('your_');

export const isAppleConfigured =
  APPLE_CLIENT_ID.length > 0 && !APPLE_CLIENT_ID.startsWith('your_');

export const API_URL = import.meta.env.VITE_API_BASE_URL ?? '';