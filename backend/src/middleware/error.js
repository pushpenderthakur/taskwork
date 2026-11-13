/**
 * Central error handling.
 *
 * Converts known error shapes (ApiError, Zod, Mongoose, duplicate keys, bad
 * JSON) into stable `{ error: { code, message } }` responses, and logs 5xx
 * errors with a stack trace while keeping 4xx responses quiet.
 */
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import ApiError from '../utils/ApiError.js';
import { env } from '../config/env.js';

/** Last-resort handler for unmatched routes. */
export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound('ROUTE_NOT_FOUND', `Cannot find ${req.method} ${req.originalUrl}`));
}

/** Mongo duplicate-key error (code 11000) or its legacy alias (11001). */
function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001;
}

/** Which unique field collided, so the message can name it. */
function duplicateTarget(error) {
  const index = String(error?.keyValue ? Object.keys(error.keyValue)[0] : error?.message ?? '');
  if (index.includes('email')) return 'email';
  if (index.includes('phone')) return 'phone';
  return 'value';
}

/** Express error middleware: `(error, req, res, next)`. */
export function errorHandler(error, req, res, _next) {
  // Unknown errors are reported as a generic 500 so internals stay private.
  let status = 500;
  let body = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };

  if (error instanceof ApiError) {
    status = error.statusCode;
    body = error.toResponse();
  } else if (error instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues[0]?.message ?? 'Invalid request.',
        details: error.issues,
      },
    };
  } else if (error instanceof mongoose.Error.ValidationError) {
    status = 400;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
      },
    };
  } else if (error instanceof mongoose.Error.CastError) {
    status = 400;
    body = { error: { code: 'INVALID_ID', message: 'Invalid identifier format.' } };
  } else if (isDuplicateKeyError(error)) {
    status = 409;
    const target = duplicateTarget(error);
    body = {
      error: {
        code: 'DUPLICATE',
        message:
          target === 'value'
            ? 'This record already exists.'
            : `An account with this ${target} already exists.`,
      },
    };
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
    body = { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } };
  }

  const loggable = status >= 500;
  if (loggable) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  } else {
    console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${status} ${body.error.code}`);
  }

  // Never try to write a second response (e.g. after streaming started).
  if (res.headersSent) return;

  res.status(status);
  // Stack traces are a development convenience only.
  if (loggable && !env.isProduction && error?.stack) {
    body.error.stack = error.stack.split('\n').slice(0, 4);
  }
  res.json(body);
}