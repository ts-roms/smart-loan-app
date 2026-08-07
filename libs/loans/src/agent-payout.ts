/**
 * The other half of a commission: paying it.
 *
 * Disbursement books the commission as an expense and a payable — the
 * agent has earned it, and the coop owes it. Nothing has left the till.
 * A payout is the cash actually going out and account 2500 coming down.
 *
 * Three states, and the whole module exists to keep them apart:
 *
 *   PIPELINE  a commission on an application that has not funded. Not
 *             earned, not owed, and not payable. It may never happen.
 *   PAYABLE   earned and booked, not yet paid. This is what the coop
 *             owes its agents right now, and what account 2500 holds.
 *   PAID      settled by a payout line.
 *
 * "Earned" from `agentBookTotals` is PAYABLE + PAID together — what the
 * agent has made over their whole career. It is the wrong number to hand
 * a cashier, which is why this is a separate calculation rather than a
 * field on the same total.
 */

export interface PayableLoan {
  loanId: string;
  loanNumber: string;
  /** Frozen on the loan at assignment. */
  commissionAmount: number | null;
  /** When the commission was booked to the ledger. Null = not earned. */
  commissionPostedAt: Date | string | null;
  /** Set once a payout line has settled it. */
  paidByPayoutId?: string | null;
}

export interface PayableSelection {
  /** Loans that may be paid right now, in the order given. */
  payable: PayableLoan[];
  /** Their total — what a payout for all of them would come to. */
  payableTotal: number;
  /** Already settled by an earlier payout. */
  paidTotal: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split an agent's loans into what can be paid now and what already was.
 *
 * A loan qualifies as payable only when the commission was actually
 * POSTED — not merely assigned. Paying on assignment would hand over
 * cash for a loan that may still be declined, and would leave the
 * payment with no payable to settle, driving account 2500 negative.
 *
 * Zero-commission loans are excluded rather than listed at ₱0.00. They
 * are noise on a payout sheet, and a line item that moves no money is a
 * line an approver has to read and dismiss.
 */
export function selectPayable(loans: readonly PayableLoan[]): PayableSelection {
  const payable: PayableLoan[] = [];
  let payableTotal = 0;
  let paidTotal = 0;

  for (const l of loans) {
    const amount = l.commissionAmount ?? 0;
    if (amount <= 0) continue;
    if (l.paidByPayoutId) {
      paidTotal += amount;
      continue;
    }
    if (!l.commissionPostedAt) continue; // earned nothing yet
    payable.push(l);
    payableTotal += amount;
  }

  return {
    payable,
    payableTotal: round2(payableTotal),
    paidTotal: round2(paidTotal),
  };
}

export class PayoutMismatchError extends Error {
  readonly code = "PAYOUT_MISMATCH" as const;
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(
      `Payout total ${got.toFixed(2)} does not match the selected commissions, which come to ${expected.toFixed(2)}. The amount paid and the lines it settles have to agree, or the payable is left standing for the difference.`,
    );
    this.name = "PayoutMismatchError";
  }
}

export class NothingPayableError extends Error {
  readonly code = "NOTHING_PAYABLE" as const;
  constructor(
    message = "None of the selected loans has a commission that is payable right now. A commission becomes payable when the loan is disbursed, and only once.",
  ) {
    super(message);
    this.name = "NothingPayableError";
  }
}

export interface PayoutDraft {
  items: Array<{ loanId: string; amount: number }>;
  total: number;
}

/**
 * Build the lines for a payout over a chosen subset of loans.
 *
 * `loanIds` is a selection, not a filter: every id must be genuinely
 * payable. An id that is already paid, not yet posted, or not this
 * agent's is refused rather than skipped — silently dropping it would
 * produce a payout smaller than the cashier was told to hand over, and
 * the difference would go unnoticed until the agent complained.
 */
export function buildPayout(
  loans: readonly PayableLoan[],
  loanIds: readonly string[],
): PayoutDraft {
  const { payable } = selectPayable(loans);
  const byId = new Map(payable.map((l) => [l.loanId, l]));

  const items: Array<{ loanId: string; amount: number }> = [];
  const rejected: string[] = [];
  for (const id of new Set(loanIds)) {
    const l = byId.get(id);
    if (!l) {
      rejected.push(id);
      continue;
    }
    items.push({ loanId: id, amount: l.commissionAmount ?? 0 });
  }

  if (rejected.length > 0) {
    const known = new Map(loans.map((l) => [l.loanId, l]));
    throw new NothingPayableError(
      `These loans cannot be paid: ${rejected
        .map((id) => {
          const l = known.get(id);
          if (!l) return `${id} (not this agent's)`;
          if (l.paidByPayoutId) return `${l.loanNumber} (already paid)`;
          if (!l.commissionPostedAt) return `${l.loanNumber} (not disbursed)`;
          return `${l.loanNumber} (no commission)`;
        })
        .join(", ")}.`,
    );
  }
  if (items.length === 0) throw new NothingPayableError();

  return {
    items,
    total: round2(items.reduce((s, i) => s + i.amount, 0)),
  };
}

/**
 * The payout total must equal the sum of its lines.
 *
 * Tolerance is half a centavo, for float dust across a dozen
 * two-decimal strings — not a rounding allowance. Anything wider and a
 * payout could quietly settle for less than it claims, leaving a
 * remainder in account 2500 that nobody is looking for.
 */
export function assertPayoutBalances(total: number, items: PayoutDraft): void {
  if (Math.abs(round2(total) - items.total) > 0.005) {
    throw new PayoutMismatchError(items.total, total);
  }
}
