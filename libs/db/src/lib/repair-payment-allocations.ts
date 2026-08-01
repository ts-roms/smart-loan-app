/**
 * Auditor for loans paid under the broken payment-allocation code.
 *
 * Until the `schedule_payment_progress` migration, `recordPayment` allocated
 * every payment against each open installment's FULL interestDue — there was
 * nowhere to record that an installment had already been part-paid. Three
 * things went wrong as a result, and all three are baked into rows that are
 * already committed:
 *
 *   1. Interest income over-recognized, principal under-credited. A
 *      borrower paying one installment in five slices had the same interest
 *      booked five times.
 *   2. Installments never flagged `paidInFullAt` unless a single payment
 *      covered the whole `totalDue`, so loans stayed open and the late-fee
 *      job kept charging installments the borrower had actually settled.
 *   3. Overpayments credited to Loans Receivable, driving it below zero,
 *      rather than to a customer-advance liability.
 *
 * None of this is fixable in SQL: recovering the truth means replaying each
 * loan's payments through the corrected allocation. That's what this module
 * does — purely, so it can be tested, and so the runner script can show a
 * dry run before anything is written.
 *
 * What it deliberately will NOT touch: loans whose schedule was force-settled
 * by early closure, restructure, write-off, or repossession. Those paths mark
 * installments paid without a matching payment allocation, so a replay would
 * invent a history that never happened. They're reported for manual review.
 */

import { allocatePayment } from "@loan/accounting";

export const REPAIR_SOURCE_REF_TYPE = "LoanPaymentAllocationRepair";

/** Account codes the audit reads back off posted payment entries. */
const INTEREST_INCOME = "4000";
const LOANS_RECEIVABLE = "1100";
const CUSTOMER_ADVANCES = "2100";
const FEE_INCOME = "4100";

export interface AuditScheduleRow {
  id: string;
  installmentNo: number;
  principalDue: number;
  interestDue: number;
  principalPaid: number;
  interestPaid: number;
  paidInFullAt: Date | null;
}

export interface AuditPayment {
  id: string;
  amount: number;
  paidOn: Date;
  reference: string | null;
}

export interface AuditJournalLine {
  accountCode: string;
  debit: number;
  credit: number;
}

export interface AuditJournalEntry {
  id: string;
  entryDate: Date;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  lines: AuditJournalLine[];
}

export interface AuditLoanInput {
  id: string;
  number: string;
  status: string;
  schedule: AuditScheduleRow[];
  payments: AuditPayment[];
  /** Journal entries for this loan's payments and late-fee accruals. */
  entries: AuditJournalEntry[];
  /**
   * Set by the caller when something other than ordinary payments settled
   * this schedule — a write-off, restructure, or repossession. The value is
   * used verbatim as the skip reason. The caller decides this because the
   * journal entries for those paths are tagged to the replacement loan or
   * the repossession case, not to this loan, so they can't be sniffed here.
   */
  forceSettledBy?: string | null;
}

export interface Split {
  interest: number;
  principal: number;
  advance: number;
}

export interface PaymentDiff {
  paymentId: string;
  paidOn: Date;
  amount: number;
  /** What the ledger says this payment was applied to. Null if never posted. */
  posted: Split | null;
  /** What the corrected allocation says it should have been. */
  expected: Split;
}

export interface CorrectedScheduleRow {
  id: string;
  installmentNo: number;
  principalPaid: number;
  interestPaid: number;
  paidInFullAt: Date | null;
  /** True when any of the three fields differs from what's stored. */
  changed: boolean;
}

export interface LoanAudit {
  loanId: string;
  loanNumber: string;
  status: string;
  /** Set when the loan can't be safely replayed; nothing else is populated. */
  skipReason: string | null;
  payments: PaymentDiff[];
  /**
   * Expected minus posted, per account, across payments that WERE posted.
   * Those three always sum to zero — the cash received is unchanged, only
   * its allocation moves — which is what lets the correcting entry balance.
   */
  delta: Split;
  /**
   * Payments with no journal entry at all (recorded while the accounting
   * period was closed, or before auto-posting). They need a fresh payment
   * entry including the cash leg, not an allocation adjustment, so they are
   * excluded from `delta` and reported for manual posting.
   */
  unpostedPaymentIds: string[];
  schedule: CorrectedScheduleRow[];
  /** The loan should be CLOSED but isn't. */
  shouldClose: boolean;
  /**
   * Late fees accrued against installments that the replay says were
   * already settled at the time. Reported, never auto-reversed — see the
   * note on `auditLoan`.
   */
  lateFeeOverAccrued: number;
  /** Nothing to do: ledger, schedule, and status all already agree. */
  clean: boolean;
}

const PENNY = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Replay one loan's payments through the corrected allocation and diff the
 * result against what is actually stored.
 *
 * Late fees are reported but never reversed here. An over-accrued penalty
 * may already have been invoiced, disputed, or partly collected, and the
 * system has a purpose-built, permission-gated path for removing one —
 * `LoanRepository.waivePenalty`, which posts the reversing entry AND leaves
 * a `PenaltyWaiver` audit row. Silently reversing accruals from a repair
 * script would produce the same ledger movement with none of the trail.
 */
export function auditLoan(loan: AuditLoanInput): LoanAudit {
  const base = {
    loanId: loan.id,
    loanNumber: loan.number,
    status: loan.status,
    lateFeeOverAccrued: 0,
  };

  const skipReason =
    loan.forceSettledBy ??
    (loan.payments.some((p) => p.reference === "EARLY_SETTLEMENT")
      ? "carries an EARLY_SETTLEMENT payment, which posts its own allocation"
      : null);
  if (skipReason) {
    return {
      ...base,
      skipReason: `${skipReason} — a replay would invent a payment history; review by hand`,
      payments: [],
      delta: { interest: 0, principal: 0, advance: 0 },
      unpostedPaymentIds: [],
      schedule: [],
      shouldClose: false,
      clean: false,
    };
  }

  // Replay against a pristine copy of the schedule.
  const rows = [...loan.schedule]
    .sort((a, b) => a.installmentNo - b.installmentNo)
    .map((r) => ({
      src: r,
      interestPaid: 0,
      principalPaid: 0,
      paidInFullAt: null as Date | null,
    }));

  const payments = [...loan.payments].sort(
    (a, b) =>
      a.paidOn.getTime() - b.paidOn.getTime() || a.id.localeCompare(b.id),
  );

  const diffs: PaymentDiff[] = [];
  for (const payment of payments) {
    const open = rows.filter((r) => r.paidInFullAt === null);
    const allocation = allocatePayment(
      payment.amount,
      open.map((r) => ({
        interestDue: r.src.interestDue,
        principalDue: r.src.principalDue,
        interestPaid: r.interestPaid,
        principalPaid: r.principalPaid,
      })),
    );

    for (const slice of allocation.perInstallment) {
      const row = open[slice.index]!;
      row.interestPaid = round2(row.interestPaid + slice.interest);
      row.principalPaid = round2(row.principalPaid + slice.principal);
      if (
        row.interestPaid + PENNY >= row.src.interestDue &&
        row.principalPaid + PENNY >= row.src.principalDue
      ) {
        row.paidInFullAt = payment.paidOn;
      }
    }

    diffs.push({
      paymentId: payment.id,
      paidOn: payment.paidOn,
      amount: payment.amount,
      posted: postedSplitFor(loan.entries, payment.id),
      expected: {
        interest: allocation.interest,
        principal: allocation.principal,
        advance: allocation.overpayment,
      },
    });
  }

  // Net ledger correction, over posted payments only. An unposted payment
  // is a different problem — it's missing its cash leg too, so rolling it
  // into this delta would produce an entry that doesn't balance.
  const delta: Split = { interest: 0, principal: 0, advance: 0 };
  const unpostedPaymentIds: string[] = [];
  for (const d of diffs) {
    if (!d.posted) {
      unpostedPaymentIds.push(d.paymentId);
      continue;
    }
    delta.interest = round2(
      delta.interest + d.expected.interest - d.posted.interest,
    );
    delta.principal = round2(
      delta.principal + d.expected.principal - d.posted.principal,
    );
    delta.advance = round2(
      delta.advance + d.expected.advance - d.posted.advance,
    );
  }

  // A prior repair run corrects the ledger with a separate adjustment entry
  // rather than rewriting the original payment entries — that's how ledgers
  // work, history stands and corrections are additive. So the raw diff above
  // still shows the original misstatement forever. Net out anything already
  // corrected, or every re-run would report the same loan as broken and an
  // operator couldn't tell "already fixed" from "still needs fixing".
  const alreadyRepaired = repairedSoFar(loan.entries);
  delta.interest = round2(delta.interest - alreadyRepaired.interest);
  delta.principal = round2(delta.principal - alreadyRepaired.principal);
  delta.advance = round2(delta.advance - alreadyRepaired.advance);

  const schedule: CorrectedScheduleRow[] = rows.map((r) => ({
    id: r.src.id,
    installmentNo: r.src.installmentNo,
    principalPaid: r.principalPaid,
    interestPaid: r.interestPaid,
    paidInFullAt: r.paidInFullAt,
    changed:
      Math.abs(r.principalPaid - r.src.principalPaid) > PENNY ||
      Math.abs(r.interestPaid - r.src.interestPaid) > PENNY ||
      sameInstant(r.paidInFullAt, r.src.paidInFullAt) === false,
  }));

  const allSettled =
    rows.length > 0 && rows.every((r) => r.paidInFullAt !== null);
  const shouldClose = allSettled && loan.status !== "CLOSED";

  // Late fees charged to installments that were already settled by then.
  let lateFeeOverAccrued = 0;
  const settledAt = new Map(
    rows.filter((r) => r.paidInFullAt).map((r) => [r.src.id, r.paidInFullAt!]),
  );
  for (const entry of loan.entries) {
    if (entry.source !== "LATE_FEE_ACCRUAL" || !entry.sourceRefId) continue;
    // sourceRefId is `${scheduleId}:${periodKey}`.
    const scheduleId = entry.sourceRefId.split(":")[0]!;
    const settled = settledAt.get(scheduleId);
    if (!settled || entry.entryDate <= settled) continue;
    lateFeeOverAccrued = round2(
      lateFeeOverAccrued +
        entry.lines
          .filter((l) => l.accountCode === FEE_INCOME)
          .reduce((s, l) => s + l.credit, 0),
    );
  }

  const ledgerClean =
    Math.abs(delta.interest) <= PENNY &&
    Math.abs(delta.principal) <= PENNY &&
    Math.abs(delta.advance) <= PENNY;

  return {
    ...base,
    skipReason: null,
    payments: diffs,
    delta,
    unpostedPaymentIds,
    schedule,
    shouldClose,
    lateFeeOverAccrued,
    clean:
      ledgerClean &&
      !shouldClose &&
      unpostedPaymentIds.length === 0 &&
      lateFeeOverAccrued <= PENNY &&
      schedule.every((r) => !r.changed),
  };
}

/**
 * The correcting journal lines for one loan, or null when the ledger is
 * already right. Cash is untouched — the money received never changed, only
 * what it was applied to — so the three deltas net to zero and the entry
 * balances by construction.
 */
export function repairEntryLines(audit: LoanAudit): Array<{
  accountCode: string;
  debit: number;
  credit: number;
  memo: string;
}> | null {
  const legs: Array<[string, number, string]> = [
    [INTEREST_INCOME, audit.delta.interest, "Interest re-allocation"],
    [LOANS_RECEIVABLE, audit.delta.principal, "Principal re-allocation"],
    [
      CUSTOMER_ADVANCES,
      audit.delta.advance,
      "Overpayment reclassified as advance",
    ],
  ];
  const lines = legs
    .filter(([, amount]) => Math.abs(amount) > PENNY)
    .map(([accountCode, amount, memo]) => ({
      accountCode,
      // A positive delta means we under-credited: credit the difference.
      // A negative delta means we over-credited: debit it back.
      debit: amount < 0 ? round2(-amount) : 0,
      credit: amount > 0 ? round2(amount) : 0,
      memo,
    }));
  return lines.length >= 2 ? lines : null;
}

/**
 * Net effect of any correcting entries a previous repair run already
 * posted, in the same sign convention as `delta` — positive means the
 * account was credited (under-credited originally).
 */
function repairedSoFar(entries: AuditJournalEntry[]): Split {
  const repairs = entries.filter(
    (e) => e.sourceRefType === REPAIR_SOURCE_REF_TYPE,
  );
  const net = (code: string) =>
    round2(
      repairs
        .flatMap((e) => e.lines)
        .filter((l) => l.accountCode === code)
        .reduce((s, l) => s + l.credit - l.debit, 0),
    );
  return {
    interest: net(INTEREST_INCOME),
    principal: net(LOANS_RECEIVABLE),
    advance: net(CUSTOMER_ADVANCES),
  };
}

/** Interest / principal / advance actually credited by a payment's entry. */
function postedSplitFor(
  entries: AuditJournalEntry[],
  paymentId: string,
): Split | null {
  const entry = entries.find(
    (e) =>
      e.source === "LOAN_PAYMENT" &&
      e.sourceRefType === "LoanPayment" &&
      e.sourceRefId === paymentId,
  );
  if (!entry) return null;
  const credited = (code: string) =>
    round2(
      entry.lines
        .filter((l) => l.accountCode === code)
        .reduce((s, l) => s + l.credit, 0),
    );
  return {
    interest: credited(INTEREST_INCOME),
    principal: credited(LOANS_RECEIVABLE),
    advance: credited(CUSTOMER_ADVANCES),
  };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}
