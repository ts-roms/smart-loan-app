import { normalizePhone } from "@loan/shared-utils";
import { z } from "zod";

import { customerResponseSchema } from "../customers/schemas";
import { loanResponseSchema } from "../loans/schemas";

/**
 * Normalised, not rejected — the length rule needs the number already
 * on file to know whether this is a change. See portal.service.
 */
const phoneField = () =>
  z
    .string()
    .max(40)
    .transform((v) => normalizePhone(v));

/**
 * Borrower-portal wire schemas. The portal is implicitly scoped to the
 * authenticated CUSTOMER user's `customerId`, so none of these
 * payloads carry a customer identifier — the service resolves it from
 * the JWT subject.
 */

/**
 * Borrower self-apply for a loan. Same surface as the officer-mediated
 * `/loans/apply` schema, minus the customerId (we never trust a
 * client-supplied one here).
 */
export const applySchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: z
    .object({
      kind: z.enum(["CAR", "MOTORCYCLE"]),
      make: z.string().min(1).max(80),
      model: z.string().min(1).max(80),
      year: z.number().int().min(1900).max(2100),
      plateNumber: z.string().max(40).optional(),
      chassisNumber: z.string().max(80).optional(),
      engineNumber: z.string().max(80).optional(),
      color: z.string().max(40).optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  property: z
    .object({
      propertyType: z.string().min(1).max(80),
      address: z.string().min(1).max(500),
      city: z.string().min(1).max(80),
      province: z.string().max(80).optional(),
      postalCode: z.string().max(20).optional(),
      titleNumber: z.string().max(80).optional(),
      taxDecNumber: z.string().max(80).optional(),
      areaSqm: z.number().positive().optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
  /** The borrower's own pre-assessment this application came out of. */
  preAssessmentId: z.string().uuid().optional(),
  /**
   * Answers to the product's KYC declaration questionnaire. Partial is
   * fine — completeness gates approval, not submission — but present
   * answers must fit their questions (validated in the service).
   */
  kycAnswers: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;

/** Body of PUT /portal/loans/:id/declarations. */
export const portalDeclarationAnswersSchema = z.object({
  answers: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type PortalDeclarationAnswersInput = z.infer<
  typeof portalDeclarationAnswersSchema
>;

export const kycSubmitSchema = z.object({
  documentType: z.enum([
    "ID_FRONT",
    "ID_BACK",
    "PROOF_OF_INCOME",
    "PROOF_OF_ADDRESS",
    "SELFIE",
    "VEHICLE_OR",
    "VEHICLE_CR",
    "PROPERTY_TITLE",
    "TAX_DECLARATION",
  ]),
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});
export type KycSubmitInput = z.infer<typeof kycSubmitSchema>;

export const intentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
});
export type IntentInput = z.infer<typeof intentSchema>;

/** Borrower signature blob (data URL or hosted asset URL). */
export const signSchema = z.object({
  signatureUrl: z.string().min(1),
});
export type SignInput = z.infer<typeof signSchema>;

/**
 * Self-service profile edit allowlist. NAMES, date of birth, gov't ID,
 * employment, income, KYC status — all deliberately absent. Those
 * require either officer re-verification or a dedicated workflow that
 * doesn't exist yet. Refusing the field is safer than letting a
 * borrower silently rewrite their KYC record.
 */
export const profileUpdateSchema = z.object({
  phone: phoneField().optional(),
  email: z.string().email().max(120).optional().nullable(),
  address: z.string().min(1).max(500).optional(),
  city: z.string().min(1).max(80).optional(),
  province: z.string().max(80).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** Combined-ledger query shape. */
export const ledgerQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  scope: z.string().optional(),
  format: z.string().optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

/* ─── Spec-only request variants ────────────────────────────────────────
 *
 * Same trick as loans/schemas.ts: `kycAnswers` / `answers` are records
 * whose values may be NULL, and `z.null()` inside a union renders
 * (openApi3 target) as `nullable` with no `type` — which AJV rejects at
 * BOOT. The attached variants widen the record value to `z.unknown()`;
 * the controller's parse of the real schema still enforces the union.
 */

export const applyRequestSchema = applySchema.extend({
  kycAnswers: z.record(z.unknown()).optional(),
});

export const portalDeclarationAnswersRequestSchema = z.object({
  answers: z.record(z.unknown()),
});

/**
 * `:id` on the loan paths — NOT `.uuid()`: `findByIdOrNumber` resolves
 * the human "LN-2026-…" number too. The payment-intent path resolves
 * "PI-2026-…" the same way.
 */
export const portalIdParamSchema = z.object({
  id: z.string().min(1),
});

/** `?format=csv` switch on the two cooperative-history exports. */
export const formatQuerySchema = z.object({
  format: z.string().optional(),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against. They
 * name what is CONTRACTUAL; undeclared fields pass through (see
 * lib/openapi.ts). House rules that are load-bearing here:
 *
 *   • Money columns are Prisma `Decimal` → STRINGS on the wire. Figures
 *     folded in JS (balances, pre-assessment maths) are real numbers.
 *   • A field declared without `.optional()` must be present on every
 *     payload the route can send — fast-json-stringify throws otherwise.
 */

/**
 * GET /portal/me — the borrower's own record plus their latest credit
 * score. `customer` is the full row; the schema reuses the staff-side
 * contractual shape (customers/schemas.ts) and lets the rest through.
 */
export const meResponseSchema = z.object({
  customer: customerResponseSchema,
  /** Null until a score has been computed for this borrower. */
  score: z
    .object({
      score: z.number(),
      tier: z.string(),
      computedAt: z.string().datetime(),
    })
    .nullable(),
});

/**
 * GET /portal/loans — the borrower's applications, newest first, each
 * carrying its current balance so the dashboard shows what is actually
 * owed rather than the original principal.
 */
export const portalLoanListResponseSchema = z.array(
  loanResponseSchema.extend({
    balance: z
      .object({
        scheduled: z.number(),
        paid: z.number(),
        outstanding: z.number(),
        principalScheduled: z.number(),
        principalPaid: z.number(),
        principalOutstanding: z.number(),
        paidInstallments: z.number().int(),
        totalInstallments: z.number().int(),
      })
      .nullable(),
  }),
);

/**
 * The self-service profile after a PATCH — the exact `select` the
 * update runs with, not the whole customer row.
 */
export const profileResponseSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  address: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  postalCode: z.string().nullable(),
  kycStatus: z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]),
});

/**
 * One row of the borrower's KYC pack, as stored. `documentType` is the
 * enum the submit schema takes; left as a plain string here so a new
 * document type never turns a 200 into a serialiser crash.
 */
export const kycSubmissionResponseSchema = z.object({
  id: z.string().uuid(),
  /** "KYC-2026-000123". */
  number: z.string(),
  customerId: z.string().uuid(),
  documentType: z.string(),
  documentUrl: z.string(),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED"]),
  notes: z.string().nullable(),
  /** Why it was rejected, when it was. */
  reason: z.string().nullable(),
  submittedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  submittedById: z.string(),
  decidedById: z.string().nullable(),
});

/** GET /portal/kyc — the documents plus the validateKyc rollup. */
export const kycListResponseSchema = z.object({
  docs: z.array(kycSubmissionResponseSchema),
  status: z.object({
    /** True only if every required doc is VERIFIED. */
    complete: z.boolean(),
    status: z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]),
    missing: z.array(z.string()),
    rejected: z.array(z.string()),
  }),
});

/**
 * A saved pre-assessment on the wire (the service's `toWire`). The
 * Decimal inputs are converted to NUMBERS there — unlike loan rows —
 * because clients do arithmetic on these.
 */
export const portalPreAssessmentResponseSchema = z.object({
  id: z.string().uuid(),
  /** "PA-2026-000123". */
  number: z.string(),
  source: z.enum(["PORTAL", "OFFICER"]),
  customerId: z.string().uuid().nullable(),
  prospectName: z.string().nullable(),
  prospectPhone: z.string().nullable(),
  prospectEmail: z.string().nullable(),
  productCode: z.string(),
  principal: z.number(),
  termMonths: z.number().int(),
  annualInterestRate: z.number(),
  monthlyIncome: z.number(),
  applicantAge: z.number().int(),
  verdict: z.enum(["APPROVE", "REVIEW", "REJECT"]),
  reason: z.string(),
  matchedRuleId: z.string().nullable(),
  matchedRuleName: z.string().nullable(),
  matchedRuleVersion: z.number().int().nullable(),
  /** FULL = a real customer's score/AML/KYC were in play. */
  basis: z.enum(["FULL", "INDICATIVE"]),
  /**
   * AML / KYC pre-flight gates, null on prospect rows. Left `unknown`:
   * a nullable object union renders as `nullable` with no `type`, the
   * exact shape that crashes boot (see the request variants above).
   */
  gates: z.unknown(),
  anomalies: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      message: z.string(),
    }),
  ),
  context: z.object({
    principal: z.number(),
    termMonths: z.number().int(),
    annualInterestRate: z.number(),
    productCode: z.string(),
    creditScore: z.number().nullable(),
    tier: z.string().nullable(),
    monthlyIncome: z.number(),
    existingActiveLoans: z.number().int(),
  }),
  /** Set once the assessment converted into a real application. */
  loanId: z.string().uuid().nullable(),
  convertedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  createdById: z.string().nullable(),
  customer: z
    .object({
      id: z.string().uuid(),
      number: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    })
    .nullable(),
});
