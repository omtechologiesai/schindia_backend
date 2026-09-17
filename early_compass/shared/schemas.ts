/**
 * Validation shared by the forms and the API, so a value the browser accepts is exactly
 * a value the server accepts.
 */
import { z } from 'zod';
import { INTEREST_OPTIONS, type InterestKey } from './data/activities';
import { GOAL_AGES, type GoalAge } from './data/goals';
import { parseISODate } from './format';
import { normalisePhone } from './phone';
import { TARGET_MAX, TARGET_MIN, TARGET_STEP } from './scoring';

export const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'] as const;
export const RELATIONS = ['Mother', 'Father', 'Guardian', 'Grandparent', 'Other'] as const;
export type Gender = (typeof GENDERS)[number];
export type Relation = (typeof RELATIONS)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTEREST_KEYS = INTEREST_OPTIONS.map((option) => option.key) as [InterestKey, ...InterestKey[]];

const personName = (label: string, max = 60) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);

const email = z.string().trim().max(120).refine((v) => EMAIL.test(v), 'Enter a valid email address');
const optionalEmail = z.string().trim().max(120).refine((v) => v === '' || EMAIL.test(v), 'Enter a valid email address');
const mobile = z.string().trim().refine((v) => normalisePhone(v) !== null, 'Enter a valid 10-digit mobile number');

export const childDetailsSchema = z.object({
  firstName: personName('First name'),
  lastName: personName('Last name'),
  dateOfBirth: z.string().refine((v) => parseISODate(v) !== null, 'Enter a valid date of birth'),
  gender: z.enum(GENDERS).nullable(),
  centre: z.string().trim().max(80),
});

export const parentContactSchema = z.object({
  name: personName('Parent or guardian name', 80),
  relation: z.enum(RELATIONS),
  phone: mobile,
  email: optionalEmail,
});

export const assessmentSubmissionSchema = z.object({
  /** Set when this is a follow-up for a child already on record. */
  childId: z.string().min(1).max(64).nullable(),
  child: childDetailsSchema,
  parent: parentContactSchema,
  band: z.enum(['0-2', '2-4', '4-6']),
  observed: z.array(z.string().max(24)).max(200),
  goals: z
    .object({
      age: z.enum(GOAL_AGES as [GoalAge, ...GoalAge[]]),
      achieved: z.array(z.string().max(80)).max(80),
    })
    .nullable(),
  interests: z.array(z.enum(INTEREST_KEYS)).max(INTEREST_KEYS.length),
  targetOverride: z
    .number()
    .int()
    .min(TARGET_MIN)
    .max(TARGET_MAX)
    .refine((v) => v % TARGET_STEP === 0, `Target must be a multiple of ${TARGET_STEP}`)
    .nullable(),
  notes: z.string().trim().max(2000, 'Notes must be 2,000 characters or fewer'),
});

export type AssessmentSubmission = z.infer<typeof assessmentSubmissionSchema>;
export type ChildDetails = z.infer<typeof childDetailsSchema>;
export type ParentContact = z.infer<typeof parentContactSchema>;

export const updateChildSchema = z.object({ child: childDetailsSchema, parent: parentContactSchema });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required').max(120),
  password: z.string().min(1, 'Password is required').max(200),
});

export const reportVariantSchema = z.enum(['full', 'short']).default('full');

export const shareEmailSchema = z.object({
  to: email,
  message: z.string().trim().max(1000, 'Message must be 1,000 characters or fewer'),
  variant: reportVariantSchema,
});

export const shareWhatsAppSchema = z.object({ to: mobile, variant: reportVariantSchema });

const password = z.string().min(10, 'Password must be at least 10 characters').max(200);

export const createUserSchema = z.object({
  name: personName('Name', 80),
  email: email.transform((v) => v.toLowerCase()),
  role: z.enum(['admin', 'staff']),
  centre: z.string().trim().max(80),
  password,
});

export const updateUserSchema = z.object({
  name: personName('Name', 80).optional(),
  role: z.enum(['admin', 'staff']).optional(),
  centre: z.string().trim().max(80).optional(),
  active: z.boolean().optional(),
  password: password.optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
  newPassword: password,
});

/** First message per field, keyed by dotted path ("parent.phone"). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    out[key] ??= issue.message;
  }
  return out;
}
