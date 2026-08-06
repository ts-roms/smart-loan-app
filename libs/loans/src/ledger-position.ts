/**
 * Two positions, kept apart.
 *
 * A member's statement used to fold loan flows and savings flows into
 * one running total called "net position". By that arithmetic a
 * borrower who repaid ₱56,735.76 on a ₱50,000 loan came out +₱6,735.76
 * and was labelled a net depositor — when that figure is the INTEREST
 * they were charged, and the coop holds none of it.
 *
 * The two are different kinds of claim and don't belong in one number:
 *
 *   OWED — what the member owes the coop. Grows by the loan's whole
 *          obligation when it is disbursed, shrinks with every payment.
 *   HELD — what the coop holds on the member's behalf. Their savings
 *          and their capital build-up, both of which are theirs to get
 *          back.
 *
 * Adding them would say a member with ₱10,000 saved and ₱10,000
 * borrowed is square with the coop. They are not: they owe ₱10,000 and
 * are owed ₱10,000, and the coop can call one in without releasing the
 * other.
 */

/** Which running total an entry moves, and in which direction. */
export type LedgerPositionKind =
  | "LOAN_DISBURSEMENT"
  | "LOAN_PAYMENT"
  | "PENALTY_WAIVER"
  | "CONTRIBUTION"
  | "SAVINGS_DEPOSIT"
  | "SAVINGS_WITHDRAWAL";

export interface PositionEntryInput {
  kind: LedgerPositionKind;
  amount: number;
  /** Present on loan entries; used to look up the total obligation. */
  loanNumber?: string | null;
  /**
   * The portion of a CONTRIBUTION the coop HOLDS for the member —
   * capital build-up — as opposed to the pooled benefit funds
   * (mortuary, emergency) in the same row, which are spent on claims
   * and never come back.
   *
   * An AMOUNT rather than a flag because one contribution row carries
   * all three funds at once: ₱700 made of ₱500 CBU, ₱100 mortuary and
   * ₱100 emergency is ₱500 held, not ₱700 and not nothing. Counting the
   * benefit funds as held would repeat the very error this split exists
   * to correct.
   */
  refundableAmount?: number;
}

export interface PositionResult {
  /** Owed by the member after this entry. Never negative. */
  owedAfter: number;
  /** Held by the coop for the member after this entry. Never negative. */
  heldAfter: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/**
 * Floored at zero. Float dust across a dozen two-decimal strings can
 * land a settled loan a few millionths under, and "you owe −₱0.00"
 * reads as a bug in the lender's favour.
 */
const atLeastZero = (n: number) => Math.max(0, n);

/**
 * Walk entries oldest-first, tracking both positions.
 *
 * `loanObligations` maps a loan number to what the member owes for it
 * IN TOTAL — principal plus all scheduled interest. The disbursement's
 * cash amount is deliberately not used: ₱50,000 handed over against a
 * ₱56,735.76 schedule means they owe ₱56,735.76 from that moment, and
 * seeding from the cash would leave the running total ending at
 * −₱6,735.76 on a loan that was in fact repaid exactly.
 *
 * A loan with no entry in the map falls back to its cash amount — the
 * best available answer for a row disbursed before schedules existed,
 * and better than dropping it from the total entirely.
 */
export function ledgerPositions(
  entries: readonly PositionEntryInput[],
  loanObligations: Readonly<Record<string, number>> = {},
): PositionResult[] {
  let owed = 0;
  let held = 0;
  return entries.map((e) => {
    switch (e.kind) {
      case "LOAN_DISBURSEMENT":
        owed += e.loanNumber
          ? (loanObligations[e.loanNumber] ?? e.amount)
          : e.amount;
        break;
      case "LOAN_PAYMENT":
        owed -= e.amount;
        break;
      case "PENALTY_WAIVER":
        // A waiver forgives part of the debt, so it reduces what is
        // owed without any money changing hands.
        owed -= e.amount;
        break;
      case "SAVINGS_DEPOSIT":
        held += e.amount;
        break;
      case "SAVINGS_WITHDRAWAL":
        held -= e.amount;
        break;
      case "CONTRIBUTION":
        // Only the refundable portion. See `refundableAmount`.
        held += e.refundableAmount ?? 0;
        break;
    }
    return {
      owedAfter: round2(atLeastZero(owed)),
      heldAfter: round2(atLeastZero(held)),
    };
  });
}
