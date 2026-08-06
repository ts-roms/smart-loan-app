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
 *          Tracked per loan and summed, never as one running total —
 *          see `LoanState`.
 *   HELD — what the coop holds on the member's behalf. Their savings,
 *          their capital build-up, and any cash paid beyond what a loan
 *          could absorb, all of which are theirs to get back.
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
 * Per-loan state. The debt is tracked LOAN BY LOAN and only summed at
 * the end, because a single running total floored at zero silently
 * writes off real debt.
 *
 * Seen in the fixtures: a member with a DEFAULTED loan he never paid a
 * peso on, and a second loan he closed and then overpaid by ₱279,360.
 * On one aggregate the overpayment cancelled the default and his
 * statement read "You owe ₱0.00" — the ₱56,735.76 he is actually in
 * default for had been absorbed by the floor.
 *
 * Overpaying one loan does not settle another. The excess is cash the
 * coop is holding, which is where it goes.
 */
interface LoanState {
  /** Total obligation: principal plus all scheduled interest. */
  obligation: number;
  /** Cash actually received against this loan. */
  paid: number;
  /** Debt forgiven — reduces the obligation, but no money moved. */
  waived: number;
  /**
   * Whether the disbursement itself is in this stream. A date-filtered
   * or scope-filtered view can show payments whose disbursement falls
   * outside the window; without this those payments would look like
   * pure overpayment and be reported as money held.
   */
  disbursed: boolean;
  /**
   * Whether the obligation is the real scheduled total or the cash
   * fallback for a loan with no schedule. Only a KNOWN obligation can
   * tell an overpayment from ordinary interest: on a legacy loan the
   * fallback is the principal, so every peso of interest ever paid
   * would read as excess cash and land in "we hold for you" — the very
   * mistake this module exists to correct.
   */
  obligationKnown: boolean;
}

const blankLoan = (): LoanState => ({
  obligation: 0,
  paid: 0,
  waived: 0,
  disbursed: false,
  obligationKnown: true,
});

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
  // Entries with no loan number share one bucket. They can't be told
  // apart, so netting them together is the only available answer.
  const loans = new Map<string, LoanState>();
  const loanState = (n: string | null | undefined): LoanState => {
    const key = n ?? "";
    let s = loans.get(key);
    if (!s) loans.set(key, (s = blankLoan()));
    return s;
  };

  let savings = 0;

  return entries.map((e) => {
    switch (e.kind) {
      case "LOAN_DISBURSEMENT": {
        const s = loanState(e.loanNumber);
        const scheduled = e.loanNumber
          ? loanObligations[e.loanNumber]
          : undefined;
        s.obligation += scheduled ?? e.amount;
        s.disbursed = true;
        if (scheduled === undefined) s.obligationKnown = false;
        break;
      }
      case "LOAN_PAYMENT":
        loanState(e.loanNumber).paid += e.amount;
        break;
      case "PENALTY_WAIVER":
        // A waiver forgives part of the debt, so it reduces what is
        // owed without any money changing hands. Tracked apart from
        // `paid` so it can never be mistaken for cash the coop holds.
        loanState(e.loanNumber).waived += e.amount;
        break;
      case "SAVINGS_DEPOSIT":
        savings += e.amount;
        break;
      case "SAVINGS_WITHDRAWAL":
        savings -= e.amount;
        break;
      case "CONTRIBUTION":
        // Only the refundable portion. See `refundableAmount`.
        savings += e.refundableAmount ?? 0;
        break;
    }

    let owed = 0;
    let advances = 0;
    for (const s of loans.values()) {
      const due = atLeastZero(s.obligation - s.waived);
      owed += atLeastZero(due - s.paid);
      // Cash beyond what this loan could absorb. The coop books it to
      // Customer Advance Payments — a liability, money it owes back —
      // so the member's statement has to show it as held.
      if (s.disbursed && s.obligationKnown) {
        advances += atLeastZero(s.paid - due);
      }
    }

    return {
      owedAfter: round2(owed),
      heldAfter: round2(atLeastZero(savings) + advances),
    };
  });
}
