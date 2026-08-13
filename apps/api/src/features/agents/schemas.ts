import { MAX_COMMISSION_RATE } from "@loan/loans";
import { z } from "zod";

/**
 * A commission rate is a FRACTION of principal, not a percentage. The
 * ceiling is a typo guard, not a policy: "2" meaning 2% would otherwise
 * book twice the principal as commission on a loan that has not earned
 * a peso. The message says so, because the person who typed it needs to
 * know what the field wanted rather than merely that it said no.
 */
const commissionRate = z
  .number()
  .min(0, "A commission rate cannot be negative.")
  .max(
    MAX_COMMISSION_RATE,
    `Enter the rate as a fraction — 0.02 for 2%, not 2. The maximum is ${MAX_COMMISSION_RATE}.`,
  );

export const createAgentSchema = z.object({
  userId: z.string().uuid(),
  /**
   * `null` and "not supplied" mean the same thing here — inherit the
   * product's rate — but zero does not, and the API has to keep them
   * apart. A zero override is the one way to say "this agent earns
   * nothing on this", and collapsing it into absent would pay them.
   */
  commissionRate: commissionRate.nullable().optional(),
  territory: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const updateAgentSchema = z
  .object({
    commissionRate: commissionRate.nullable().optional(),
    territory: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Nothing to update.",
  });

export const agentListQuerySchema = z.object({
  active: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  q: z.string().trim().min(1).max(120).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export const agentBookQuerySchema = z.object({
  status: z.string().trim().min(1).max(32).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

/**
 * `agentId: null` clears the assignment. Explicitly nullable rather than
 * optional so "remove the agent" is a thing the caller can say, instead
 * of being indistinguishable from "leave it alone".
 */
export const assignAgentSchema = z.object({
  agentId: z.string().uuid().nullable(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

// ─── Payouts ────────────────────────────────────────────────────────────

export const createPayoutSchema = z.object({
  agentId: z.string().uuid(),
  /**
   * The loans this payment settles. Explicit rather than "pay
   * everything outstanding": a cashier paying ₱40,000 of a ₱52,000
   * balance needs to say which loans that covers, and the agent needs
   * to be able to read it back.
   */
  loanIds: z.array(z.string().uuid()).min(1, "Select at least one loan."),
  /**
   * What is actually being handed over. Checked against the selected
   * commissions server-side and refused if they disagree — a payout
   * that settles for less than it claims leaves a remainder in account
   * 2500 that nobody goes looking for.
   */
  amount: z.number().positive(),
  paidOn: z.coerce.date(),
  method: z.string().trim().max(40).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const voidPayoutSchema = z.object({
  /**
   * Required, and not trivially satisfiable. A voided payout is money
   * that left and came back; six months later the only account of why
   * will be this sentence.
   */
  reason: z.string().trim().min(10, "Say why this payout is being voided."),
});

export const payoutListQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

/* ─── Spec-only request variant ─────────────────────────────────────────
 *
 * `paidOn` is `z.coerce.date()`, which renders as `format: "date-time"`
 * — and AJV's date-time refuses the date-only "2026-08-14" that
 * `new Date(...)` (and therefore the controller's parse) accepts. The
 * attached variant widens it to a bare string so nothing the handler
 * accepts is refused at the door; the controller's coerce still runs.
 */
export const createPayoutRequestSchema = createPayoutSchema.extend({
  paidOn: z.string(),
});

/**
 * `:id` — an agent accepts a uuid or "AGT-…", a payout a uuid or
 * "APO-…", so no `.uuid()` here.
 */
export const agentIdParamSchema = z.object({
  id: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). The money rule is SPLIT in this feature and worth
 * reading twice: the list/get/book/payable/payout-list paths map their
 * rows in JS and answer NUMBERS, while POST /agents, PATCH /agents/:id,
 * POST /payouts and the void answer raw Prisma rows whose Decimal
 * columns (commissionRate, payout amount) arrive as STRINGS.
 */

const agentBookTotalsSchema = z.object({
  /** Loans assigned to this agent, whatever their status. */
  loanCount: z.number().int(),
  /** Of those, the ones that reached disbursement. */
  fundedCount: z.number().int(),
  /** Commission on funded loans. */
  earned: z.number(),
  /** Commission riding on applications still in flight. Not banked. */
  pipeline: z.number(),
});

/** A directory row — mapped in JS, numbers throughout. */
export const agentSummaryResponseSchema = z.object({
  id: z.string().uuid(),
  /** "AGT-2026-000007". Accepted in place of the id on /agents/:id. */
  number: z.string(),
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  /** Fraction of principal. Null = inherit the product's rate. */
  commissionRate: z.number().nullable(),
  territory: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  deactivatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  totals: agentBookTotalsSchema,
});

export const agentListResponseSchema = z.array(agentSummaryResponseSchema);

/**
 * The raw stored row the write paths return — no user join, no totals,
 * and `commissionRate` is a Decimal STRING here, unlike the summary.
 */
export const agentRowResponseSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  userId: z.string().uuid(),
  /** Decimal on the wire — "0.0200" for 2%. */
  commissionRate: z.string().nullable(),
  territory: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  deactivatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

/** One loan of an agent's book — mapped in JS, numbers. */
const agentBookLoanSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  status: z.string(),
  productCode: z.string(),
  principal: z.number(),
  submittedAt: z.string().datetime(),
  disbursedAt: z.string().datetime().nullable(),
  customerName: z.string(),
  customerNumber: z.string(),
  /** Frozen at assignment. Null on rows assigned before a rate existed. */
  commissionRate: z.number().nullable(),
  commissionAmount: z.number().nullable(),
  /** Set once the commission was booked to the ledger, at disbursement. */
  commissionPostedAt: z.string().datetime().nullable(),
});

/** GET /agents/:id/book and GET /agents/me — the agent and their loans. */
export const agentBookResponseSchema = z.object({
  agent: agentSummaryResponseSchema,
  loans: z.array(agentBookLoanSchema),
  /** Over the WHOLE book, not the returned page. */
  totals: agentBookTotalsSchema,
});

/** A loan whose commission is booked and not yet settled by a payout. */
const payableLoanSchema = z.object({
  loanId: z.string().uuid(),
  loanNumber: z.string(),
  customerName: z.string(),
  principal: z.number(),
  commissionAmount: z.number(),
  postedAt: z.string().datetime(),
});

/** GET /agents/:id/payable — the staff view of what an agent is owed. */
export const agentPayableResponseSchema = z.object({
  agent: agentSummaryResponseSchema,
  loans: z.array(payableLoanSchema),
  /** Owed right now — booked, unpaid. */
  payableTotal: z.number(),
  /** Settled by earlier payouts. */
  paidTotal: z.number(),
});

/** A payout on the list path — mapped in JS, numbers. */
const payoutListItemSchema = z.object({
  id: z.string().uuid(),
  /** "APO-2026-000003". Accepted in place of the id on the void path. */
  number: z.string(),
  agentId: z.string().uuid(),
  agentNumber: z.string(),
  agentName: z.string(),
  amount: z.number(),
  paidOn: z.string().datetime(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  /** Non-null = this payout was reversed; its loans are payable again. */
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  items: z.array(
    z.object({
      loanId: z.string().uuid(),
      loanNumber: z.string(),
      amount: z.number(),
    }),
  ),
});

export const payoutListResponseSchema = z.array(payoutListItemSchema);

/** GET /agents/me/payable — the agent's own view, payout history included. */
export const myPayableResponseSchema = z.object({
  loans: z.array(payableLoanSchema),
  payableTotal: z.number(),
  paidTotal: z.number(),
  payouts: payoutListResponseSchema,
});

/**
 * The raw stored payout row the write paths return — `amount` is a
 * Decimal STRING here, unlike the list.
 */
export const payoutRowResponseSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  agentId: z.string().uuid(),
  /** Decimal on the wire. */
  amount: z.string(),
  paidOn: z.string().datetime(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdById: z.string().nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  voidedById: z.string().nullable(),
});

/** POST /agents/payouts 201 — the row plus its settled lines. */
export const payoutCreateResponseSchema = payoutRowResponseSchema.extend({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      payoutId: z.string().uuid(),
      loanId: z.string().uuid(),
      /** Decimal on the wire. */
      amount: z.string(),
    }),
  ),
});
