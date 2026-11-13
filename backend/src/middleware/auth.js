/**
 * Bearer-token authentication middleware.
 *
 * Accepts the access token from the `Authorization: Bearer` header (SPA fetch
 * calls) or the `access_token` cookie (same-origin requests), then loads the
 * user so route handlers can rely on `req.user` being a live document.
 */
import { User } from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/tokens.js';

/** Header first, cookie second. */
function extractToken(req) {
  const header = req.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('bearer ')) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  return req.cookies?.access_token ?? null;
}

export async function authenticate(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      throw ApiError.unauthorized('NO_TOKEN', 'Authentication required.');
    }

    // Signature, issuer, audience and expiry are validated by jsonwebtoken.
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw ApiError.unauthorized('INVALID_TOKEN', 'Session expired. Please sign in again.');
    }

    // The token may still be valid while the account was deleted or disabled.
    const user = await User.findById(payload.sub);
    if (!user) {
      throw ApiError.unauthorized('USER_NOT_FOUND', 'Account no longer exists.');
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}