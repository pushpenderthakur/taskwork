/**
 * Email delivery (OTP).
 *
 * Uses nodemailer. Without `SMTP_HOST` (or `SMTP_SERVICE`) there is no
 * transport, so the code is printed to the server console and flagged as
 * undelivered — which is what makes the `devCode` fallback work in development.
 * A failed send becomes `502 EMAIL_DELIVERY_FAILED`.
 */
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import ApiError from './ApiError.js';

// Transporter cache: rebuilt when the connection settings change.
let cache = { key: '', transporter: null };

/** Cache key for the current transport settings. */
function transportKey() {
  return [
    env.smtp.service,
    env.smtp.host,
    env.smtp.port,
    env.smtp.secure,
    env.smtp.user,
  ].join('|');
}

/** Returns a transporter, or null when no transport is configured. */
function getTransporter() {
  if (!env.smtp.host && !env.smtp.service) return null;

  const key = transportKey();
  if (cache.key === key && cache.transporter) return cache.transporter;

  cache = {
    key,
    transporter: nodemailer.createTransport({
      ...(env.smtp.service ? { service: env.smtp.service } : {}),
      host: env.smtp.host || undefined,
      port: env.smtp.host ? env.smtp.port : undefined,
      secure: env.smtp.host ? env.smtp.secure : undefined,
      auth:
        env.smtp.user && env.smtp.pass
          ? { user: env.smtp.user, pass: env.smtp.pass }
          : undefined,
    }),
  };

  return cache.transporter;
}

/** True when a real transport exists (used by health checks and tests). */
export function isEmailDeliveryConfigured() {
  return Boolean(env.smtp.host || env.smtp.service);
}

/** Sends one verification code; throws `EMAIL_DELIVERY_FAILED` on failure. */
export async function sendOtpEmail({ to, code, expiresInSeconds }) {
  const minutes = Math.round(expiresInSeconds / 60);
  const text = `Your Taskwork verification code is ${code}. It expires in ${minutes} minutes. Never share this code with anyone.`;

  const mailer = getTransporter();
  if (!mailer) {
    console.info(`[mailer] SMTP not configured - OTP for ${to}: ${code}`);
    return { delivered: false, transport: 'console' };
  }

  try {
    await mailer.sendMail({
      from: env.smtp.from,
      to,
      subject: 'Your Taskwork verification code',
      text,
      html: `<div style="font-family:system-ui,sans-serif"><h2>Your verification code</h2>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
        <p>Expires in ${minutes} minutes. Never share this code.</p></div>`,
    });
  } catch (error) {
    // The transport target and the reason are useful; credentials never appear
    // in nodemailer errors, but keep the client message generic anyway.
    console.error(
      `[mailer] failed to send OTP to ${to} via ${env.smtp.host || env.smtp.service}:`,
      error?.message ?? error,
    );
    throw new ApiError(
      502,
      'EMAIL_DELIVERY_FAILED',
      'Could not send the verification email. Please try again.',
    );
  }

  return { delivered: true, transport: 'smtp' };
}