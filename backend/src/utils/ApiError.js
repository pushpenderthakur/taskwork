/**
 * Typed HTTP error.
 *
 * Throwing an `ApiError` anywhere in a request lets the central error handler
 * return a stable `{ error: { code, message } }` body, so route handlers never
 * write error responses themselves.
 */
export default class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status to send.
   * @param {string} code - Stable machine-readable code (e.g. `OTP_EXPIRED`).
   * @param {string} message - Human-readable message safe for clients.
   * @param {*} [details] - Optional extra context (validation issues, ...).
   */
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /** Body sent to the client by the error middleware. */
  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required.') {
    return new ApiError(401, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found.') {
    return new ApiError(404, code, message);
  }

  static conflict(code, message) {
    return new ApiError(409, code, message);
  }

  static forbidden(code, message) {
    return new ApiError(403, code, message);
  }

  static tooManyRequests(message = 'Too many requests, please try again later.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
}