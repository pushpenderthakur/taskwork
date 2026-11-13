import { z } from 'zod';
import ApiError from '../utils/ApiError.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => emailPattern.test(value), { message: 'Enter a valid email address.' });

export const phoneField = z
  .string()
  .trim()
  .regex(/^\d{10}$/, { message: 'Enter a valid 10-digit phone number.' });

export const otpField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'OTP must be 6 digits.' });

export const identifierField = (method) =>
  method === 'email' ? emailField : phoneField;

export const methodSchema = z.enum(['email', 'phone']);

export const sendOtpSchema = z
  .object({
    method: methodSchema,
    identifier: z.string().trim().min(1),
    isLogin: z.boolean(),
    name: z.string().trim().max(80).optional(),
  })
  .superRefine((value, ctx) => {
    const field = identifierField(value.method);
    const result = field.safeParse(value.identifier);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifier'],
        message: result.error.issues[0]?.message ?? 'Invalid identifier.',
      });
    }
  });

export const verifyOtpSchema = z
  .object({
    method: methodSchema,
    identifier: z.string().trim().min(1),
    otp: otpField,
    name: z.string().trim().max(80).optional(),
  })
  .superRefine((value, ctx) => {
    const field = identifierField(value.method);
    const result = field.safeParse(value.identifier);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifier'],
        message: result.error.issues[0]?.message ?? 'Invalid identifier.',
      });
    }
  });

export const googleSchema = z.object({
  token: z.string().trim().min(10, { message: 'A Google token is required.' }),
});

// Apple sends the name as `{ firstName, middleName, lastName }` on the first
// authorisation only; a plain string is accepted for other clients.
export const appleNameSchema = z
  .union([
    z.string().trim().max(80),
    z
      .object({
        firstName: z.string().trim().max(60).optional(),
        middleName: z.string().trim().max(60).optional(),
        lastName: z.string().trim().max(60).optional(),
      })
      .strict(),
  ])
  .optional();

export const appleSchema = z.object({
  identityToken: z
    .string()
    .trim()
    .min(10, { message: 'An Apple identity token is required.' }),
  name: appleNameSchema,
});

export function parseOrThrow(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, 'VALIDATION_ERROR', first?.message ?? 'Invalid request body.', {
      issues: result.error.issues,
    });
  }
  return result.data;
}