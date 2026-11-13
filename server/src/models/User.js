import mongoose from 'mongoose';

const { Schema } = mongoose;

const providerSchema = new Schema(
  {
    id: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const refreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    userAgent: { type: String, trim: true, maxlength: 255, default: null },
    ip: { type: String, trim: true, maxlength: 64, default: null },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 80, default: null },
    email: { type: String, trim: true, lowercase: true, default: null },
    phone: { type: String, trim: true, default: null },
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
userSchema.index({ 'providers.google.id': 1 }, { sparse: true });
userSchema.index({ 'providers.apple.id': 1 }, { sparse: true });

export const User = mongoose.model('User', userSchema);
export default User;