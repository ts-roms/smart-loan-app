/**
 * Collection priority weights — §29.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THESE WEIGHTS ARE A STARTING POLICY. THEY ARE NOT CALIBRATED.
 *
 * Nothing here was fitted against realised recovery outcomes, because
 * this deployment has never recorded the thing you would fit against:
 * which worked accounts actually paid, how much, and how soon after
 * which contact. They encode a collections manager's priors about what
 * matters — money at stake first, then how far gone, then what the
 * borrower has actually done when previously asked — and no more than
 * that.
 *
 * Treat them as a hypothesis with a number attached. The honest test is
 * to log queue position against subsequent recovery for a quarter and
 * refit. Until that happens, a claim that this ranking is "optimal"
 * would be made up, and the ordering should be read as informed triage
 * rather than prediction.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Weights are the share of the final 0–100 score each factor can
 * contribute at full strength. They sum to 1 — asserted at module load
 * below, so a later edit that forgets to rebalance fails loudly instead
 * of silently rescaling every score in the queue.
 */

/** Stable identifiers for the factors. Used as map keys and in output. */
export type PriorityFactorId =
  | "exposureAtRisk"
  | "delinquencyDepth"
  | "promiseReliability"
  | "contactability"
  | "repaymentHistory"
  | "riskGrade"
  | "collateralCoverage";

export const COLLECTION_PRIORITY_WEIGHTS: Record<PriorityFactorId, number> = {
  /**
   * Money actually at stake on this account.
   *
   * The heaviest single factor, and the one that most changes a
   * collector's day. A queue sorted by days overdue spends equal effort
   * on a ₱4,000 balance and a ₱400,000 one; weighting exposure is what
   * makes the same eight hours recover more pesos. It is not the whole
   * story — a large balance you cannot reach is worth less than a small
   * one you can — which is why it is 0.24 and not 0.5.
   */
  exposureAtRisk: 0.24,

  /**
   * How far past due, banded by §28's seven aging bands.
   *
   * Still a first-class signal: arrears deepen, and an account left
   * alone rolls to the next band. Deliberately NOT the top weight,
   * because "sort by DPD" is precisely the behaviour this score exists
   * to replace. It ranks second, not first.
   */
  delinquencyDepth: 0.22,

  /**
   * What the borrower did the last time they were asked to commit.
   *
   * Observed promise-to-pay outcomes — kept vs broken. The strongest
   * *behavioural* evidence in this schema, and the only factor built on
   * what the borrower did rather than on what they owe. Read the caveat
   * in `priority.ts`: this is promise reliability, NOT the modelled
   * probability of payment §29 asks for.
   */
  promiseReliability: 0.16,

  /**
   * Whether this account can be worked at all today.
   *
   * Phone, alternate phone and email on file, plus how recently anyone
   * logged a contact attempt. Weighted moderately because it gates
   * effort rather than value: an unreachable account is not less
   * important, it is differently actionable, and the recommended
   * channel — not the score — is where that mostly gets handled.
   */
  contactability: 0.12,

  /**
   * The borrower's track record across their whole book.
   *
   * Prior loans closed cleanly vs defaulted or written off. Slow-moving
   * and backward-looking, so it informs rather than drives: someone with
   * six clean loans and one bad month is a different proposition from a
   * serial defaulter at the same DPD.
   */
  repaymentHistory: 0.1,

  /**
   * Credit grade — the risk tier from the scorecard.
   *
   * Deliberately small. The tier was set at origination and is stale by
   * the time an account reaches collections; the borrower's *current*
   * behaviour, already captured by promise reliability and delinquency
   * depth, is better evidence. Kept because a grade that was poor from
   * the outset still carries information, but not enough to outrank
   * anything observed since.
   */
  riskGrade: 0.08,

  /**
   * Secured recovery available if collection fails.
   *
   * Appraised collateral value against the outstanding balance. Small on
   * purpose, and its direction deserves a word: collateral RAISES
   * priority here. That looks backwards — a secured account is safer —
   * but the queue is about actionability, and a secured account has a
   * live path to money (repossession has a deadline and a legal clock)
   * where an unsecured one has only persuasion. The security is a reason
   * to act, not a reason to relax.
   */
  collateralCoverage: 0.08,
};

/**
 * Fail at import if the weights stop summing to 1.
 *
 * Without this, editing one weight silently rescales every score in the
 * book: the same account scores differently after a change that was
 * never meant to touch it, and nothing anywhere reports an error. A
 * queue that quietly reorders itself is worse than one that refuses to
 * load.
 */
const WEIGHT_SUM = Object.values(COLLECTION_PRIORITY_WEIGHTS).reduce(
  (sum, weight) => sum + weight,
  0,
);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `COLLECTION_PRIORITY_WEIGHTS must sum to 1, got ${WEIGHT_SUM}. ` +
      `Rebalance the weights in libs/collections/src/weights.ts.`,
  );
}

/** Human labels, kept beside the weights so the two cannot drift. */
export const PRIORITY_FACTOR_LABELS: Record<PriorityFactorId, string> = {
  exposureAtRisk: "Exposure at risk",
  delinquencyDepth: "Delinquency depth",
  promiseReliability: "Promise reliability",
  contactability: "Contactability",
  repaymentHistory: "Repayment history",
  riskGrade: "Risk grade",
  collateralCoverage: "Collateral coverage",
};

/**
 * The balance at which exposure scores full marks.
 *
 * Exposure is normalised against this ceiling rather than against the
 * largest balance in the current queue. A relative scale would make
 * every account's score depend on which other accounts happen to be
 * delinquent today — the same borrower would move up the queue because
 * someone else cured, and a collector comparing yesterday's list to
 * today's would be comparing two different scales.
 *
 * Set to a round figure near the top of the consumer book. Balances
 * above it all score 1.0; discriminating further up is not useful,
 * since anything this size is being worked regardless.
 *
 * ─── Known limitation: the scale is LINEAR ───────────────────────────
 *
 * A ₱6,000 balance scores 1.2% of the exposure weight and a ₱60,000 one
 * scores 12%, so at the small end exposure contributes almost nothing
 * while the borrower-quality factors — delinquency depth, repayment
 * history, risk grade — saturate at 1.0 and contribute everything they
 * have. The observable effect: a tiny, ancient, unreachable account with
 * a bad history still lands mid-queue, carried there by three maxed-out
 * factors it cannot be rescued from, when the ₱6,000 at stake says it
 * should be near the bottom.
 *
 * A concave scale (√ or log) would fix it — the gap between ₱6k and
 * ₱60k genuinely matters more than the gap between ₱440k and ₱500k, so
 * a curve is the better model of how a collections manager reads a
 * balance. It is deliberately NOT applied here: choosing a curve is
 * exactly the kind of decision that should be made against realised
 * recovery data rather than against whichever shape makes a demo look
 * tidiest, and linear is the version whose behaviour a reader can
 * predict without running it. Revisit this first when the calibration
 * described at the top of this file happens.
 */
export const EXPOSURE_CEILING = 500_000;

/**
 * §29 inputs this score does NOT contain, and why.
 *
 * Recorded in the output rather than left as a silent omission. A
 * collector — or an auditor — reading a "priority score" is entitled to
 * know it is missing two of the eight inputs the requirement names, and
 * a factor list that quietly runs short is how a six-factor score gets
 * described as an eight-factor one.
 */
export const UNSOURCED_FACTORS: ReadonlyArray<{
  requirement: string;
  reason: string;
}> = [
  {
    requirement: "Probability of Payment",
    reason:
      "No such model exists in this system. It is a fitted output — the " +
      "probability that this borrower pays within a horizon — and fitting " +
      "it needs labelled recovery outcomes nobody has collected yet. " +
      "`promiseReliability` is the nearest observed signal and is scored " +
      "separately under its own name; it is a count of kept vs broken " +
      "promises, not a probability, and must not be read as one.",
  },
  {
    requirement: "Recovery Probability",
    reason:
      "Also a model output, and a harder one — it depends on collateral " +
      "realisation rates, legal timelines and post-write-off recoveries " +
      "this deployment has too few of to fit against. `collateralCoverage` " +
      "scores the security actually on file, which is an input to recovery " +
      "probability, not an estimate of it.",
  },
];
