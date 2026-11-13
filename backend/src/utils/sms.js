/**
 * SMS delivery (OTP).
 *
 * Twilio is the only provider wired in: `SMS_PROVIDER=twilio` plus the Account
 * SID, Auth Token and sender. Anything else (or nothing at all) falls back to a
 * console log so local development still works. Failures surface as
 * `502 SMS_DELIVERY_FAILED` and a missing configuration as `503 SMS_NOT_CONFIGURED`.
 */
import { env } from '../config/env.js';
import ApiError from './ApiError.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** `+91 98****10`, safe for logs. */
function maskPhone(to) {
  const digits = to.replace(/^\+/, '');
  return `+${env.sms.countryCode} ${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

/** Adds the configured country code unless the number is already in E.164. */
function toE164(to) {
  return to.startsWith('+') ? to : `+${env.sms.countryCode}${to}`;
}

/** Twilio credentials, or null when the provider is not fully configured. */
function twilioCredentials() {
  const { accountSid, authToken, from } = env.twilio;
  if (accountSid && authToken && from) return { accountSid, authToken, from };
  return null;
}

/** True when Twilio can actually send. */
export function isSmsDeliveryConfigured() {
  return twilioCredentials() !== null;
}

/** The SMS text, shared by every provider. */
function messageBody(code, expiresInSeconds) {
  const minutes = Math.round(expiresInSeconds / 60);
  return `Your Taskwork verification code is ${code}. It expires in ${minutes} minutes. Never share this code with anyone.`;
}

/** POSTs the message to Twilio's Messages API. */
async function sendViaTwilio({ to, body }) {
  const { accountSid, authToken, from } = twilioCredentials();

  let response;
  try {
    response = await fetch(`${env.twilio.apiBase}/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(
      502,
      'SMS_DELIVERY_FAILED',
      'Could not send the verification SMS. Please try again.',
    );
  }

  if (!response.ok) {
    console.error(
      `[sms] twilio rejected the message for ${maskPhone(to)}: ${response.status}`,
    );
    throw new ApiError(
      502,
      'SMS_DELIVERY_FAILED',
      'Could not send the verification SMS. Please try again.',
    );
  }

  return { delivered: true, transport: 'twilio' };
}

/** Sends one code; logs it when no provider is configured. */
export async function sendOtpSms({ to, code, expiresInSeconds }) {
  const body = messageBody(code, expiresInSeconds);

  if (env.sms.provider === 'twilio') {
    if (!twilioCredentials()) {
      console.error(
        '[sms] SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are incomplete',
      );
      throw new ApiError(
        503,
        'SMS_NOT_CONFIGURED',
        'SMS delivery is not configured on the server.',
      );
    }
    return sendViaTwilio({ to, body });
  }

  console.info(
    `[sms] no provider configured - OTP for ${maskPhone(to)}: ${code} (valid ${Math.round(
      expiresInSeconds / 60,
    )} min) in ${env.nodeEnv}`,
  );
  return { delivered: false, transport: 'console' };
}