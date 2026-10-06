import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { CREDENTIAL_IDS, NOTIFICATION_CATALOGUE, PACK_IDS, REGION_IDS, cityCountry, isoDateToUtcDay, normaliseCountryCode, normaliseLanguage } from '@opennjob/core';

/** Validates a request body/query against a zod schema; replies 400 with the list of problems. */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const isoDate = z.string().refine((v) => isoDateToUtcDay(v) !== undefined, 'must be a real date in YYYY-MM-DD format');

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** ISO 3166-1 alpha-2, any case in, upper case out. Checked against the full list in packages/core/src/geo.ts. */
const countryCode = z
  .string()
  .trim()
  .refine((v) => normaliseCountryCode(v) !== undefined, 'must be an ISO 3166-1 alpha-2 country code, for example GB or CD')
  .transform((v) => normaliseCountryCode(v) as string);

const languageName = z
  .string()
  .trim()
  .refine((v) => normaliseLanguage(v) !== undefined, 'must be one of: English, French, Lingala, Swahili, Arabic, German, Spanish, Portuguese')
  .transform((v) => normaliseLanguage(v) as string);

/**
 * Candidate preferences. Every list may be empty, and empty means "no restriction":
 * if nothing is selected, everything is available.
 * A city must be one OpennJob knows the country of, or be written "City, CC" (e.g. "Lille, FR"),
 * because a city only narrows the country it belongs to.
 */
export const preferencesSchema = z
  .object({
    languages: z.array(languageName).max(20).default([]).transform(unique),
    countries: z.array(countryCode).max(249).default([]).transform(unique),
    cities: z
      .array(text(100).refine((v) => cityCountry(v) !== undefined, 'unknown city: write it with its country code, for example "Lille, FR"'))
      .max(100)
      .default([])
      .transform(unique),
    searchTypes: z.array(z.enum(['uk-permanent', 'uk-contract', 'international'])).max(3).default([]).transform(unique),
  })
  .strict();

export const profileSchema = z
  .object({
    firstName: text(100),
    lastName: text(100),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().regex(/^[+()\d][\d\s()-]{6,24}$/, 'must be a phone number'),
    addressLine1: text(200),
    addressLine2: optionalText(200),
    city: text(100),
    postcode: text(12),
    cvText: z.string().trim().min(20, 'CV text is too short').max(50_000),
    preferences: preferencesSchema.optional(),
  })
  .strict();

export const passportSchema = z
  .object({
    // Format is deliberately loose: OpennJob stores what the user typed and does not verify it with the NMC.
    nmcPin: z.string().trim().regex(/^[A-Za-z0-9]{6,10}$/, 'must be 6 to 10 letters and digits').optional(),
    // Credential id -> what the user typed. Ids come from the pack registry (prof, sc, cdm, pm, cscs,
    // smsts, pts, lang, rtw, pin, dbs). Free text: OpennJob stores it and verifies none of it.
    credentials: z
      .record(z.string(), z.string().trim().min(1).max(200))
      .refine((v) => Object.keys(v).every((k) => CREDENTIAL_IDS.includes(k)), `credential ids must be among: ${CREDENTIAL_IDS.join(', ')}`)
      .optional(),
    dbs: z
      .object({
        certificateNumber: z.string().trim().regex(/^\d{12}$/, 'must be 12 digits').optional(),
        issueDate: isoDate.optional(),
        onUpdateService: z.boolean().optional(),
      })
      .strict()
      .optional(),
    rightToWorkConfirmed: z.boolean(),
    training: z
      .array(z.object({ name: text(120), completedOn: isoDate.optional(), expiresOn: isoDate.optional() }).strict())
      .max(50)
      .default([]),
    referees: z
      .array(
        z
          .object({
            name: text(120),
            relationship: text(120),
            organisation: text(160),
            email: z.string().trim().email().max(254),
            phone: z.string().trim().regex(/^[+()\d][\d\s()-]{6,24}$/, 'must be a phone number'),
          })
          .strict(),
      )
      .max(3)
      .default([]),
  })
  .strict();

export const createApplicationSchema = z
  .object({ jobId: text(200), mode: z.enum(['review', 'hybrid', 'auto']).default('hybrid') })
  .strict();

export const confirmApplicationSchema = z
  .object({ confirmedFields: z.array(text(200)).min(1).max(200) })
  .strict();

/** The user's own edit of a drafted statement. Same upper bound as an LLM draft could reach, with room to spare. */
export const statementSchema = z.object({ statement: z.string().trim().min(1).max(20_000) }).strict();

const notificationKey = z.string().trim().max(80).refine((k) => NOTIFICATION_CATALOGUE.some((e) => e.key === k), 'unknown notification event');

export const notificationPreferencesSchema = z
  .object({ email: z.boolean(), sms: z.boolean(), push: z.boolean(), whatsapp: z.boolean(), muted: z.array(notificationKey).max(200).default([]).transform(unique) })
  .strict();

export const markReadSchema = z.object({ ids: z.array(text(200)).min(1).max(500).optional() }).strict();

export const notificationTestSchema = z.object({ event: notificationKey.default('account.test') }).strict();

export const notificationPreviewSchema = z.object({ event: notificationKey });

export const interviewFeedbackSchema = z
  .object({ questionId: text(80).optional(), question: text(500).optional(), answer: z.string().trim().min(1).max(8000) })
  .strict()
  .refine((v) => Boolean(v.questionId) !== Boolean(v.question), 'provide exactly one of questionId or question');

export const minScoreSchema = z
  .union([z.undefined(), z.string().regex(/^\d{1,3}$/, 'min must be a whole number from 0 to 100')])
  .transform((v) => (v === undefined ? 0 : Number(v)))
  .refine((n) => n >= 0 && n <= 100, 'min must be a whole number from 0 to 100');

const packId = z.enum(PACK_IDS as [string, ...string[]]);

export const questionQuerySchema = z.object({
  role: z.enum(['nurse', 'hca', 'support-worker']).optional(),
  category: z.enum(['values', 'clinical']).optional(),
  pack: packId.optional(),
});

/** Optional filters on GET /jobs/matches. `min` is validated separately. */
export const matchFilterSchema = z.object({
  min: z.unknown().optional(),
  pack: packId.optional(),
  region: z.enum(REGION_IDS as [string, ...string[]]).optional(),
  country: countryCode.optional(),
});

export const agentRunSchema = z.object({ mode: z.enum(['review', 'hybrid', 'auto']).default('hybrid') }).strict();

const criterionSchema = z
  .object({ label: text(120), essential: z.boolean(), keywords: z.array(text(60)).min(1).max(8) })
  .strict();

/**
 * An employer posting a job. OPTIONAL: OpennJob finds jobs itself and nothing depends on
 * this route. `criteria` may be left out, in which case they are read from the description.
 */
export const employerJobSchema = z
  .object({
    title: text(200),
    employer: text(200),
    description: z.string().trim().min(20, 'description is too short').max(20_000),
    country: countryCode,
    city: text(100),
    applyUrl: z.string().trim().url().max(2000).refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL'),
    language: z.enum(['en', 'fr']).optional(),
    pack: packId.optional(),
    requiredCredential: z.string().trim().refine((v) => CREDENTIAL_IDS.includes(v), `must be among: ${CREDENTIAL_IDS.join(', ')}`).optional(),
    criteria: z.array(criterionSchema).max(15).optional(),
    salaryMin: z.number().nonnegative().optional(),
    salaryMax: z.number().nonnegative().optional(),
    employmentType: optionalText(60),
  })
  .strict();

const accountEmail = z.string().trim().toLowerCase().email().max(254);
const version = z.string().trim().min(1).max(40);

/**
 * Registration. The password's rules (length and so on) are checked in auth.ts so the
 * reply can name each problem; here it only has to be a string of a sane size.
 * `acceptedTermsVersion` and `acceptedPrivacyVersion` are required: there is no account
 * without recorded consent.
 */
export const registerSchema = z
  .object({ email: accountEmail, password: z.string().min(1).max(1000), acceptedTermsVersion: version, acceptedPrivacyVersion: version })
  .strict();

export const loginSchema = z.object({ email: accountEmail, password: z.string().min(1).max(1000) }).strict();

export const deleteAccountSchema = z.object({ password: z.string().min(1).max(1000) }).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type MatchFilterInput = z.infer<typeof matchFilterSchema>;
export type AgentRunInput = z.infer<typeof agentRunSchema>;
export type EmployerJobInput = z.infer<typeof employerJobSchema>;
export type PassportInput = z.infer<typeof passportSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type ConfirmApplicationInput = z.infer<typeof confirmApplicationSchema>;
export type StatementInput = z.infer<typeof statementSchema>;
export type InterviewFeedbackInput = z.infer<typeof interviewFeedbackSchema>;
