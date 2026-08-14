import { z } from "zod";

/**
 * Demand Letter schemas.
 *
 * Stage ladder: FIRST (60d) → FINAL (90d) → ATTORNEY_FIRST → ATTORNEY_FINAL.
 * Status ladder: DRAFTED → APPROVED → DISPATCHED → (RESPONDED | WAIVED).
 *
 * Approval permissions and segregation-of-duties checks live in the
 * service — the schemas here are the wire-format only.
 */

export const stageEnum = z.enum([
  "FIRST",
  "FINAL",
  "ATTORNEY_FIRST",
  "ATTORNEY_FINAL",
]);
export type DemandLetterStageEnum = z.infer<typeof stageEnum>;

export const statusEnum = z.enum([
  "DRAFTED",
  "APPROVED",
  "DISPATCHED",
  "RESPONDED",
  "WAIVED",
]);
export type DemandLetterStatusEnum = z.infer<typeof statusEnum>;

export const candidatesQuerySchema = z.object({
  stage: stageEnum,
});
export type CandidatesQuery = z.infer<typeof candidatesQuerySchema>;

export const listQuerySchema = z.object({
  stage: stageEnum.optional(),
  status: statusEnum.optional(),
  loanId: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const batchSchema = z.object({
  loanIds: z.array(z.string().uuid()).min(1).max(200),
  stage: stageEnum,
  paymentDeadlineDays: z.number().int().min(1).max(60).optional(),
});
export type BatchInput = z.infer<typeof batchSchema>;

export const approveSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ApproveInput = z.infer<typeof approveSchema>;

export const dispatchSchema = z.object({
  channel: z.string().min(1).max(40),
  ref: z.string().max(120).optional(),
});
export type DispatchInput = z.infer<typeof dispatchSchema>;

export const closeSchema = z.object({
  status: z.enum(["RESPONDED", "WAIVED"]),
  reason: z.string().min(3).max(500),
});
export type CloseInput = z.infer<typeof closeSchema>;

/** `:id` on the per-letter routes. */
export const letterIdParamSchema = z.object({ id: z.string().uuid() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 *
 * BOTH money conventions appear here, on fields with the SAME NAMES,
 * and getting them the wrong way round is the easiest mistake in this
 * file:
 *
 *   • On a LETTER, `principalOwed`/`interestOwed`/`penaltiesOwed`/
 *     `totalOwed` are Prisma `Decimal(14,2)` columns — snapshotted at
 *     draft time so the letter stays faithful if the borrower part-pays
 *     before dispatch — and therefore STRINGS on the wire.
 *   • On a CANDIDATE, the identically-named fields have never been near
 *     the database. `identifyCandidates` folds them in JS from the
 *     open schedule rows, so they are real NUMBERS.
 *
 * A candidate is what a letter would say if you drafted one; a letter
 * is what one already said. Same figures, different provenance, and the
 * wire types differ accordingly.
 */

/**
 * A letter as stored. Every write endpoint — approve, dispatch, close —
 * answers this same row with more of the stage fields filled in, and
 * the ladder is visible in the nullables: `approved*` set at approval,
 * `dispatch*` at dispatch, `closed*` at either close outcome.
 */
export const letterResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  stage: stageEnum,
  status: statusEnum,
  /** Decimal on the wire — snapshotted at draft time. */
  principalOwed: z.string(),
  /** Decimal on the wire — snapshotted at draft time. */
  interestOwed: z.string(),
  /** Decimal on the wire — snapshotted at draft time. */
  penaltiesOwed: z.string(),
  /** Decimal on the wire — principal + interest + penalties, at draft. */
  totalOwed: z.string(),
  daysOverdue: z.number().int(),
  /** The date the letter tells the borrower to pay by. */
  paymentDeadline: z.string().datetime(),
  /** The rendered letter body, captured at draft so it cannot drift. */
  body: z.string(),
  draftedAt: z.string().datetime(),
  draftedById: z.string(),
  approvedAt: z.string().datetime().nullable(),
  approvedById: z.string().nullable(),
  approvalNote: z.string().nullable(),
  dispatchedAt: z.string().datetime().nullable(),
  dispatchedById: z.string().nullable(),
  /** Free-form: EMAIL / SMS / COURIER / POST, or whatever comes next. */
  dispatchChannel: z.string().nullable(),
  dispatchRef: z.string().nullable(),
  closedAt: z.string().datetime().nullable(),
  closedById: z.string().nullable(),
  closedReason: z.string().nullable(),
});

/**
 * GET /demand-letters — newest first, each carrying the loan reference
 * the list view needs so it does not have to fetch every loan.
 */
export const letterListResponseSchema = z.array(
  letterResponseSchema.extend({
    loan: z.object({
      /** "LN-2026-000123". */
      number: z.string(),
      customerId: z.string().uuid(),
    }),
  }),
);

/**
 * GET /demand-letters/candidates — loans overdue past the stage's
 * threshold with no active letter at that stage. Nothing here is
 * persisted: it is the drafting shortlist, computed per request, and
 * its money fields are JS numbers (see the note above).
 */
export const candidateListResponseSchema = z.array(
  z.object({
    loanId: z.string().uuid(),
    /** "LN-2026-000123". */
    loanNumber: z.string(),
    customerId: z.string().uuid(),
    customerName: z.string(),
    email: z.string().nullable(),
    phone: z.string(),
    /** Folded in JS — a number, unlike the letter's Decimal string. */
    principalOwed: z.number(),
    /** Folded in JS — a number, unlike the letter's Decimal string. */
    interestOwed: z.number(),
    /** Folded in JS — a number, unlike the letter's Decimal string. */
    penaltiesOwed: z.number(),
    /** Folded in JS — a number, unlike the letter's Decimal string. */
    totalOwed: z.number(),
    daysOverdue: z.number().int(),
    /** The most recent letter at this stage, if the cooldown has passed. */
    lastLetterAtStageId: z.string().nullable(),
    lastLetterAtStageAt: z.string().datetime().nullable(),
  }),
);

/**
 * POST /demand-letters/batch — the letters actually drafted.
 *
 * `created` can be LOWER than the number of loan ids sent, and that is
 * not an error: the batch re-derives the candidate set as it runs, and
 * a loan that stopped qualifying in between (someone paid) is skipped
 * silently rather than failing the whole call.
 */
export const batchResponseSchema = z.object({
  created: z.number().int(),
  letters: z.array(letterResponseSchema),
});
