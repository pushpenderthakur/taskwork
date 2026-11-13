import { env } from '../config/env.js';

// No SMS provider is configured by default. Plug a provider (Twilio, MSG91,
// AWS SNS, ...) here; the interface is just { to, code, expiresInSeconds }.
export async function sendOtpSms({ to, code, expiresInSeconds }) {
  const masked = `+91 ${to.slice(0, 2)}****${to.slice(-2)}`;
  console.info(
    `[sms] no provider configured - OTP for ${masked}: ${code} (valid ${Math.round(
      expiresInSeconds / 60,
    )} min) in ${env.nodeEnv}`,
  );
  return { delivered: false, transport: 'console' };
}