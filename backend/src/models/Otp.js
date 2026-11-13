/**
 * One-time password records.
 *
 * A row exists only while a code is live: requesting a new code upserts the same
 * `{ method, identifier }` document, and MongoDB's TTL index deletes it once it
 * expires. Codes are never stored in plain text.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    // Which channel the code was sent on.
    method: { type: String, enum: ['email', 'phone'], required: true },
    // Normalised destination (lower-case email or 10 digits).
    identifier: { type: String, required: true, trim: true },
    // Name supplied during registration, kept so `verify-otp` can create the user.
    name: { type: String, trim: true, maxlength: 80, default: null },
    // bcrypt hash of the 6 digit code.
    codeHash: { type: String, required: true },
    // Wrong guesses so far; at OTP_MAX_ATTEMPTS the code is dead.
    attempts: { type: Number, default: 0, min: 0 },
    // Set once the code is used, so a replay is rejected.
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    // Drives the resend cooldown.
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Mongo removes documents once expiresAt passes.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Only one live OTP per destination: resending replaces the previous one.
otpSchema.index({ method: 1, identifier: 1 }, { unique: true });

export const Otp = mongoose.model('Otp', otpSchema);
export default Otp;