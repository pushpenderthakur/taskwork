export function serializeUser(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.name ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    emailVerified: Boolean(user.emailVerified),
    phoneVerified: Boolean(user.phoneVerified),
    providers: {
      google: Boolean(user.providers?.google?.id),
      apple: Boolean(user.providers?.apple?.id),
    },
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt ?? null,
  };
}