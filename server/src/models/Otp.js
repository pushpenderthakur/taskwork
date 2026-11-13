import mongoose from 'mongoose';

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    method: { type: String, enum: ['email', 'phone'], required: true },
    identifier: { type: String, required: true, trim: true },
    name: { type: String, trim: true, maxlength: 80, default: null },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
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