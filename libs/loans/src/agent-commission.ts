/**
 * What an agent earns for bringing in a loan.
 *
 * A field agent is paid a fraction of the principal on what they help
 * originate. Two knobs decide the fraction, and the order between them
 * is the whole of the policy:
 *
 *   1. the agent's own rate, when they have been given one
 *   2. otherwise the product's default rate
 *
 * The resolved rate is FROZEN onto the loan at assignment. It is not
 * looked up again on read, because an admin retuning a product rate
 * tomorrow must not restate what an agent earned on a loan funded last
 * quarter — and that cuts both ways, so "the new rate is higher" is not
 * a reason to recompute either.
 */

/** Where a loan's commission rate came from. Surfaced in the UI. */
export type CommissionRateSource = "AGENT_OVERRIDE" | "PRODUCT_DEFAULT";

export interface CommissionInput {
  /** Loan principal in PHP. */
  principal: number;
  /**
   * The agent's override, as a fraction of principal. `null` or
   * `undefined` means they have none and the product's rate applies.
   *
   * Zero is NOT the same as absent: an agent explicitly set to 0 earns
   * nothing, and must not silently inherit the product's rate.
   */
  agentRate?: number | null;
  /** The product's default rate. Products default this to 0. */
  productRate: number;
}

export interface CommissionQuote {
  /** The rate actually applied, as a fraction of principal. */
  rate: number;
  /** `principal × rate`, rounded to centavos. Never negative. */
  amount: number;
  source: CommissionRateSource;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ceiling on any commission rate. Not a policy view on what an agent
 * ought to earn — a guard against a fat finger. A rate is a FRACTION,
 * so someone typing "2" meaning 2% would otherwise book twice the
 * principal as commission on a loan that hasn't earned a peso yet.
 */
export const MAX_COMMISSION_RATE = 0.5;

export class InvalidCommissionRateError extends Error {
  constructor(readonly rate: number) {
    super(
      `Commission rate ${rate} is out of range — it must be a fraction between 0 and ${MAX_COMMISSION_RATE} (${MAX_COMMISSION_RATE * 100}%). A rate above 1 usually means a percentage was entered where a fraction was expected.`,
    );
    this.name = "InvalidCommissionRateError";
  }
}

/** Throws rather than clamping: a bad rate is a typo to be corrected. */
export function assertValidCommissionRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_COMMISSION_RATE) {
    throw new InvalidCommissionRateError(rate);
  }
}

/**
 * Resolve the rate and compute the amount.
 *
 * Both rates are validated, including the one that loses, so a bad
 * override is reported when it is set rather than lying dormant until
 * the day a product's rate is removed and it becomes the live one.
 */
export function quoteCommission(input: CommissionInput): CommissionQuote {
  assertValidCommissionRate(input.productRate);
  if (input.agentRate !== null && input.agentRate !== undefined) {
    assertValidCommissionRate(input.agentRate);
  }

  // `??`, deliberately, not `||`. An agent set to 0 earns nothing; with
  // `||` that zero would fall through to the product's rate and pay
  // them anyway — the one case the override exists to express.
  const hasOverride = input.agentRate !== null && input.agentRate !== undefined;
  const rate = hasOverride ? input.agentRate! : input.productRate;

  return {
    rate,
    // Floored at zero for the same reason the ledger's positions are:
    // a negative commission would read as the agent owing the coop,
    // which is not a thing this feature can express.
    amount: round2(Math.max(0, input.principal) * rate),
    source: hasOverride ? "AGENT_OVERRIDE" : "PRODUCT_DEFAULT",
  };
}

// ─── An agent's book ────────────────────────────────────────────────────

/**
 * Loan statuses that count as "this agent got paid".
 *
 * Commission is earned at DISBURSEMENT, so anything that never reached
 * that point earns nothing however far it got through the chain. An
 * APPROVED loan is not a funded one, and paying on approval would make
 * an agent's earnings drop when a loan they were credited for fell over
 * before release.
 */
export const COMMISSION_EARNED_STATUSES: ReadonlySet<string> = new Set([
  "DISBURSED",
  "ACTIVE",
  "CLOSED",
  "DEFAULTED",
  // Restructured too. You can only restructure a loan that was funded,
  // so the money went out and the commission was paid; the replacement
  // is a separate loan that stands on its own.
  "RESTRUCTURED",
  "WRITTEN_OFF",
]);

/**
 * A defaulted or written-off loan stays in `earned`.
 *
 * The commission was paid in cash when the money went out and it is not
 * being reclaimed — that would be a clawback, which this product
 * deliberately does not do. Dropping those rows would make an agent's
 * total fall retroactively and disagree with what the ledger shows they
 * were actually paid.
 */
export interface AgentBookRow {
  status: string;
  /** Frozen on the loan at assignment. Null on loans with no agent. */
  commissionAmount?: number | null;
}

export interface AgentBookTotals {
  /** Loans assigned to this agent, whatever their status. */
  loanCount: number;
  /** Of those, the ones that reached disbursement. */
  fundedCount: number;
  /** Commission on funded loans — what the agent has been paid. */
  earned: number;
  /**
   * Commission on loans still working their way through: submitted,
   * approved, not yet released. What they stand to make if every one
   * of them lands, and nothing they can count on.
   */
  pipeline: number;
}

export function agentBookTotals(
  rows: readonly AgentBookRow[],
): AgentBookTotals {
  let fundedCount = 0;
  let earned = 0;
  let pipeline = 0;

  for (const r of rows) {
    const amount = r.commissionAmount ?? 0;
    if (COMMISSION_EARNED_STATUSES.has(r.status)) {
      fundedCount += 1;
      earned += amount;
    } else if (r.status !== "REJECTED" && r.status !== "CANCELLED") {
      // Rejected and cancelled applications are not pipeline. Leaving
      // them in would show an agent a number that can only ever fall.
      pipeline += amount;
    }
  }

  return {
    loanCount: rows.length,
    fundedCount,
    earned: round2(earned),
    pipeline: round2(pipeline),
  };
}
