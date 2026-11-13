/**
 * Account document.
 *
 * One user can sign in with an email, a phone number, Google or Apple, so the
 * record keeps verification flags per channel plus the linked provider ids.
 * Only hashed refresh tokens are stored, which is what makes sign-out and
 * reuse detection possible.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

/** A linked social account: the provider's stable subject id. */
const providerSchema = new Schema(
  {
    id: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** One live or revoked session. `tokenHash` is a SHA-256 digest, never the token. */
const refreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    userAgent: { type: String, trim: true, maxlength: 255, default: null },
    ip: { type: String, trim: true, maxlength: 64, default: null },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    // Revoked rows are kept so a replay can be detected and the family killed.
    revokedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 80, default: null },
    email: { type: String, trim: true, lowercase: true, default: null },
    phone: { type: String, trim: true, default: null },
    // Only set once the channel has been verified (OTP or provider).
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    providers: {
      google: { type: providerSchema, default: undefined },
      apple: { type: providerSchema, default: undefined },
    },
    refreshTokens: { type: [refreshTokenSchema], default: [] },
    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      // Never serialise a whole user document by accident.
      transform(_doc, ret) {
        delete ret.refreshTokens;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One account per email and per phone. The partial filter keeps the many
// "no email" / "no phone" documents from colliding on a shared null value.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
// Sparse because only linked accounts have a provider id.
userSchema.index({ 'providers.google.id': 1 }, { sparse: true });
userSchema.index({ 'providers.apple.id': 1 }, { sparse: true });

export const User = mongoose.model('User', userSchema);
export default User;