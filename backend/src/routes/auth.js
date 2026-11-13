/**
 * `/api/auth` routes.
 *
 * Each handler validates the body, delegates to a service, sets the session
 * cookies and returns the token plus the serialised user. Business rules live in
 * the services; this file only wires HTTP concerns (cookies, status codes).
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  oauthLimiter,
  sendOtpLimiter,
  verifyOtpLimiter,
} from '../middleware/rateLimiters.js';
import {
  issueSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  sendOtp,
  serializeUser,
  signInWithProvider,
  verifyOtp,
} from '../services/authService.js';
import {
  verifyAppleIdentityToken,
  verifyGoogleAccessToken,
  normalizeAppleName,
} from '../services/oauthService.js';
import {
  appleSchema,
  googleSchema,
  parseOrThrow,
  sendOtpSchema,
  verifyOtpSchema,
} from '../validators/auth.js';
import {
  accessCookieOptions,
  hashToken,
  refreshCookieOptions,
} from '../utils/tokens.js';

const router = Router();

/** Device metadata recorded on each session row. */
function sessionContext(req) {
  return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
}

/** Writes the httpOnly access and refresh cookies. */
function setSessionCookies(res, { accessToken, refreshToken }) {
  res.cookie('access_token', accessToken, accessCookieOptions());
  res.cookie('refresh_token', refreshToken, refreshCookieOptions());
}

/** Clears both cookies (logout, logout-all, failed refresh). */
function clearSessionCookies(res) {
  res.clearCookie('access_token', { ...accessCookieOptions(), maxAge: undefined });
  res.clearCookie('refresh_token', { ...refreshCookieOptions(), maxAge: undefined });
}

/** Refresh token from the cookie, or from the body for non-browser clients. */
function readRefreshToken(req) {
  return req.cookies?.refresh_token ?? req.body?.refreshToken ?? null;
}

/** Request a code for an email or phone number (202 when sent). */
router.post('/send-otp', sendOtpLimiter, async (req, res) => {
  const payload = parseOrThrow(sendOtpSchema, req.body);
  const result = await sendOtp(payload);

  res.status(202).json({
    success: true,
    message: `Verification code sent to ${result.destination}.`,
    ...result,
  });
});

/** Verify a code and start a session. */
router.post('/verify-otp', verifyOtpLimiter, async (req, res) => {
  const payload = parseOrThrow(verifyOtpSchema, req.body);
  const session = await verifyOtp({ ...payload, context: sessionContext(req) });

  setSessionCookies(res, session);
  res.status(200).json({
    success: true,
    message: 'Authentication successful.',
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
});

/** Rotate the refresh token and issue a new access token. */
router.post('/refresh', async (req, res) => {
  const session = await rotateSession(readRefreshToken(req), sessionContext(req));

  setSessionCookies(res, session);
  res.status(200).json({
    success: true,
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
});

/** Current user for the signed-in session. */
router.get('/me', authenticate, async (req, res) => {
  res.status(200).json({ success: true, user: serializeUser(req.user) });
});

// Every active session for the signed in user, with the current one flagged.
router.get('/sessions', authenticate, async (req, res) => {
  const rawRefreshToken = readRefreshToken(req);
  const currentHash = rawRefreshToken ? hashToken(rawRefreshToken) : null;

  res.status(200).json({
    success: true,
    sessions: listSessions(req.user, currentHash),
  });
});

/** Ends the session that owns this refresh token. */
router.post('/logout', async (req, res) => {
  const revoked = await revokeSession(readRefreshToken(req));
  clearSessionCookies(res);
  res.status(200).json({ success: true, revoked });
});

// Revoke every session, including the one making the request.
router.post('/logout-all', authenticate, async (req, res) => {
  const revoked = await revokeAllSessions(req.user);
  clearSessionCookies(res);
  res.status(200).json({ success: true, revoked });
});

/** Google sign-in with an access token from the SPA popup. */
router.post('/google', oauthLimiter, async (req, res) => {
  const { token } = parseOrThrow(googleSchema, req.body);
  const profile = await verifyGoogleAccessToken(token);
  const user = await signInWithProvider({ provider: 'google', profile });
  const session = await issueSession(user, sessionContext(req));

  setSessionCookies(res, session);
  res.status(200).json({
    success: true,
    message: 'Google login successful.',
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
});

/** Apple sign-in with an identity token (and the first-login name). */
router.post('/apple', oauthLimiter, async (req, res) => {
  const { identityToken, name } = parseOrThrow(appleSchema, req.body);
  const profile = await verifyAppleIdentityToken(identityToken);
  const user = await signInWithProvider({
    provider: 'apple',
    profile,
    name: normalizeAppleName(name),
  });
  const session = await issueSession(user, sessionContext(req));

  setSessionCookies(res, session);
  res.status(200).json({
    success: true,
    message: 'Apple login successful.',
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
});

export default router;