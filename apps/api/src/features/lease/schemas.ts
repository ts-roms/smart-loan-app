import { z } from "zod";

/**
 * Lease-to-Own request schemas. Agreements are created automatically
 * when `LoanRepository.disburse` runs against a lease product, so there
 * is no create endpoint — only state transitions (buyout, pull-out,
 * return, extend) and reads.
 */

/** `?status=...` filter on the index endpoint. */
export const listQuerySchema = z.object({
  status: z
    .enum(["ACTIVE", "PULLED_OUT", "BUYOUT_COMPLETED", "RETURNED", "EXTENDED"])
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Borrower paid the buyout price and is keeping the unit. */
export const buyoutSchema = z.object({
  amountPaid: z.number().positive(),
});
export type BuyoutInput = z.infer<typeof buyoutSchema>;

/** Repossession path — required reason for the audit trail. */
export const pullOutSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type PullOutInput = z.infer<typeof pullOutSchema>;

/**
 * Shared shape for the "return" and "extend" terminal-state writes.
 * Both demand a reason; the distinction lives in the route + audit
 * action, not the body.
 */
export const closeSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type CloseInput = z.infer<typeof closeSchema>;

/**
 * `:loanId` — every route in this feature is keyed by the LOAN, not by
 * the agreement's own id. `LeaseAgreement.loanId` is unique, so the
 * lookup is exact; the agreement id never appears in a path.
 */
export const loanIdParamSchema = z.object({ loanId: z.string().uuid() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 *
 * The money rule is uniform in this feature, which makes it easy: every
 * amount on a LeaseAgreement is a Prisma `Decimal(14,2)` column read
 * straight off the row, so `residualValue` and `buyoutPaidAmount` are
 * both STRINGS on the wire. Nothing here is folded in JS, so there is no
 * number-vs-string split of the kind agents and demand-letters carry —
 * note that `buyoutSchema.amountPaid` going IN is a number and the
 * `buyoutPaidAmount` coming back out is a string, which is the same
 * round trip through Postgres every Decimal makes.
 */

const leaseStatusSchema = z.enum([
  "ACTIVE",
  "PULLED_OUT",
  "BUYOUT_COMPLETED",
  "RETURNED",
  "EXTENDED",
]);

/**
 * A lease agreement as stored. Created automatically by
 * `LoanRepository.disburse` against a lease product — there is no
 * create endpoint — and thereafter only moved between states, so every
 * write route in this feature answers this same row with more of the
 * terminal fields populated.
 */
export const agreementResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  status: leaseStatusSchema,
  /** Decimal on the wire — the residual due at end-of-term. */
  residualValue: z.string(),
  /** Flips to CUSTOMER once a buyout completes. */
  titleHolder: z.enum(["COMPANY", "CUSTOMER"]),
  /** Employees can never be pulled out — the flow is non-employee only. */
  isEmployee: z.boolean(),
  /** Consecutive missed payments. Reset to 0 on any payment. */
  missedPaymentStreak: z.number().int(),
  lastPullOutWarningAt: z.string().datetime().nullable(),
  endOfTermNoticeSentAt: z.string().datetime().nullable(),
  lastMaintenanceReminderAt: z.string().datetime().nullable(),
  /** Decimal on the wire — set at buyout, null before it. */
  buyoutPaidAmount: z.string().nullable(),
  buyoutAt: z.string().datetime().nullable(),
  buyoutById: z.string().nullable(),
  buyoutJournalEntryId: z.string().nullable(),
  pulledOutAt: z.string().datetime().nullable(),
  pulledOutById: z.string().nullable(),
  pullOutReason: z.string().nullable(),
  /** Set on RETURNED or EXTENDED — the two non-buyout terminal states. */
  closedAt: z.string().datetime().nullable(),
  closedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * GET /lease — newest first (up to 200), each with the loan reference
 * the list view needs so it does not fetch every loan separately.
 */
export const agreementListResponseSchema = z.array(
  agreementResponseSchema.extend({
    loan: z.object({
      /** "LN-2026-000123". */
      number: z.string(),
      customerId: z.string().uuid(),
    }),
  }),
);

/**
 * POST /lease/:loanId/buyout — the only write here that does not answer
 * a bare agreement.
 *
 * A buyout moves money as well as state: it posts a journal entry,
 * flips title to the customer and closes the loan. The JE id is
 * returned alongside so the caller can link straight to it rather than
 * hunting for the entry by date. Answers 201, unlike the other three
 * transitions, because the journal entry is genuinely new.
 */
export const buyoutResponseSchema = z.object({
  agreement: agreementResponseSchema,
  /** The buyout journal entry this call posted. */
  journalEntryId: z.string(),
});
