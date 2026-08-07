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
