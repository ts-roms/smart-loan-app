import { DORSI_BASIS_MIN_LENGTH } from "@loan/shared-types";
import { z } from "zod";

/** Tag a customer as Director/Officer/Stockholder/Related-Interest. */
export const tagSchema = z.object({
  customerId: z.string().uuid(),
  category: z.enum(["DIRECTOR", "OFFICER", "STOCKHOLDER", "RELATED_INTEREST"]),
  /**
   * Trimmed before length-checking, so whitespace can't pad a basis to
   * the minimum. The shared constant is the single source — see its
   * comment for why 10 and why existing records aren't affected.
   */
  basis: z
    .string()
    .trim()
    .min(
      DORSI_BASIS_MIN_LENGTH,
      `Basis must explain the relationship (at least ${DORSI_BASIS_MIN_LENGTH} characters)`,
    )
    .max(500),
});

/** Reason captured on deactivation, kept in the audit trail. */
export const deactivateSchema = z.object({
  reason: z.string().min(3).max(500),
});

/** Preview a proposed loan against the DORSI caps without persisting. */
export const checkSchema = z.object({
  customerId: z.string().uuid(),
  principal: z.number().positive(),
});

/** Board-approval intake when a loan would breach a DORSI cap. */
export const boardApprovalSchema = z.object({
  loanId: z.string().uuid(),
  meetingDate: z.string(),
  minutesRef: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

/** Admin-only update of the company total equity (the cap base). */
export const configUpdateSchema = z.object({
  companyTotalEquity: z.number().nonnegative(),
});

/**
 * Auto-screen body — used at customer onboarding.
 *
 * Validated by the controller via `safeParse`, so the failure shape is
 * the standard `{ error: "ValidationError", issues: [...] }`. The
 * pre-layered route returned `{ error: "ValidationError", message:
 * "name required (>= 2 chars)" }` from an inline guard — the new
 * shape matches every other zod-validated endpoint in the API. If a
 * caller relied on the literal `message` field, that consumer needs
 * an update.
 */
export const screenByNameSchema = z.object({
  name: z.string().min(2).max(200),
});

export type TagInput = z.infer<typeof tagSchema>;
export type DeactivateInput = z.infer<typeof deactivateSchema>;
export type CheckInput = z.infer<typeof checkSchema>;
export type BoardApprovalInput = z.infer<typeof boardApprovalSchema>;
export type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;

/* ─── Request params, for the OpenAPI spec ──────────────────────────────
 *
 * Both deliberately loose. `:id` lands in a Prisma update whose miss is
 * caught as a 400 BadRequest today; `:customerId` in a findUnique that
 * answers 404. Tightening either to `.uuid()` would change which status
 * a malformed id receives.
 */

export const dorsiIdParamSchema = z.object({
  id: z.string().min(1),
});

export const dorsiCustomerParamSchema = z.object({
  customerId: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). Everything monetary here is COMPUTED in JS — caps,
 * outstanding, utilization — so unlike most of the API these really are
 * numbers, not Decimal strings.
 */

const dorsiCategorySchema = z.enum([
  "DIRECTOR",
  "OFFICER",
  "STOCKHOLDER",
  "RELATED_INTEREST",
]);

/** A register row as stored. Re-tagging reactivates the same row. */
export const dorsiRecordResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  category: dorsiCategorySchema,
  /** Why the person is DORSI — free text, min length enforced on write. */
  basis: z.string(),
  active: z.boolean(),
  lastReviewedAt: z.string().datetime().nullable(),
  lastReviewedById: z.string().nullable(),
  taggedAt: z.string().datetime(),
  taggedById: z.string(),
  deactivatedAt: z.string().datetime().nullable(),
  deactivatedById: z.string().nullable(),
  deactivationReason: z.string().nullable(),
});

/** GET /dorsi — active register rows, borrower identity joined in. */
export const dorsiListResponseSchema = z.array(
  dorsiRecordResponseSchema.extend({
    customer: z.object({
      number: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      phone: z.string(),
    }),
  }),
);

/**
 * GET /dorsi/utilization. `configured: false` means equity is zero —
 * caps are 0 and the pct fields are meaningless.
 */
export const dorsiUtilizationResponseSchema = z.object({
  configured: z.boolean(),
  companyTotalEquity: z.number(),
  /** 15% of total equity. */
  aggregateCap: z.number(),
  aggregateOutstanding: z.number(),
  aggregateUtilizationPct: z.number(),
  /** 30% of the aggregate cap, per borrower. */
  individualCap: z.number(),
  perBorrower: z.array(
    z.object({
      customerId: z.string().uuid(),
      customerNumber: z.string(),
      customerName: z.string(),
      category: dorsiCategorySchema,
      outstanding: z.number(),
      utilizationPct: z.number(),
    }),
  ),
});

/**
 * POST /dorsi/check — cap preview for a proposed loan. BOARD_REQUIRED
 * also covers the unconfigured-equity case (fail closed).
 */
export const dorsiCheckResponseSchema = z.object({
  status: z.enum(["OK", "BOARD_REQUIRED", "NOT_DORSI"]),
  aggregateOutstanding: z.number(),
  aggregateCap: z.number(),
  individualOutstanding: z.number(),
  individualCap: z.number(),
  projectedAggregateUtilization: z.number(),
  projectedIndividualUtilization: z.number(),
  /** Reason text the UI surfaces near the apply button. */
  message: z.string(),
});

/** POST /dorsi/screen-by-name — fuzzy matches, best first. Empty = clear. */
export const dorsiScreenResponseSchema = z.array(
  z.object({
    recordId: z.string().uuid(),
    customerId: z.string().uuid(),
    customerNumber: z.string(),
    customerName: z.string(),
    category: dorsiCategorySchema,
    /** 1.0 exact, 0.85 token subset, 0.5 family-name overlap. */
    similarity: z.number(),
    reason: z.string(),
  }),
);

/** A board approval as stored. The pct columns are Floats — numbers. */
export const dorsiBoardApprovalResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  /** Snapshot of the projected utilization the board attested to. */
  aggregateUtilizationPct: z.number(),
  individualUtilizationPct: z.number(),
  meetingDate: z.string().datetime(),
  minutesRef: z.string().nullable(),
  note: z.string().nullable(),
  approvedAt: z.string().datetime(),
  approvedById: z.string(),
});

/** GET /dorsi/config — the cap base and who last set it. */
export const dorsiConfigResponseSchema = z.object({
  companyTotalEquity: z.number(),
  updatedAt: z.string().datetime(),
  updatedById: z.string().nullable(),
});

/** PUT /dorsi/config echoes only the value it wrote. */
export const dorsiConfigUpdateResponseSchema = z.object({
  companyTotalEquity: z.number(),
});
