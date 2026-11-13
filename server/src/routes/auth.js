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

function sessionContext(req) {
  return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
}

function setSessionCookies(res, { accessToken, refreshToken }) {
  res.cookie('access_token', accessToken, accessCookieOptions());
  res.cookie('refresh_token', refreshToken, refreshCookieOptions());
}

function clearSessionCookies(res) {
  res.clearCookie('access_token', { ...accessCookieOptions(), maxAge: undefined });
  res.clearCookie('refresh_token', { ...refreshCookieOptions(), maxAge: undefined });
}

function readRefreshToken(req) {
  return req.cookies?.refresh_token ?? req.body?.refreshToken ?? null;
}

router.post('/send-otp', sendOtpLimiter, async (req, res) => {
  const payload = parseOrThrow(sendOtpSchema, req.body);
  const result = await sendOtp(payload);

  res.status(202).json({
    success: true,
    message: `Verification code sent to ${result.destination}.`,
    ...result,
  });
});

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