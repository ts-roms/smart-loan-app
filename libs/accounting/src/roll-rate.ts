/**
 * Roll-rate analysis (§30) — how delinquency MOVES between aging bands
 * across two points in time.
 *
 * The aging report answers "how late is the book today"; this answers
 * "which way is it going". A portfolio where 40% of CURRENT rolls into
 * 1–30 each month is deteriorating even while today's aging table looks
 * fine — roll rates are the leading indicator, aging the lagging one.
 *
 * Pure, like the other builders in this package: the repository fetches
 * loans + schedule rows, this computes. No DB access here.
 *
 * ── How a PAST snapshot is rebuilt ─────────────────────────────────────
 *
 * Band membership at a date X is derived from schedule rows exactly:
 * an installment was unpaid at X iff `paidInFullAt` is null OR
 * `paidInFullAt > X` — a payment made after X cannot count as paid at X.
 * Days-overdue at X is then X minus the earliest such row's dueDate,
 * classified with the same `agingBucketFor` the aging report uses. So the
 * CLASSIFICATION side of the matrix (which band, and the counts and
 * fractions built from it) is an exact reconstruction.
 *
 * What is NOT exactly reconstructible is the effect of PARTIAL payments
 * on amounts: `LoanSchedule.principalPaid`/`interestPaid` are cumulative
 * current values with no timestamps, and `LoanPayment` rows are not tied
 * to installments, so "how much of installment 7 was paid as of X" cannot
 * be recovered. Rather than ship an amount that silently drifts each time
 * the report is re-run, the amounts here are GROSS: a loan's exposure at
 * X is the full contractual `totalDue` of every installment unpaid at X.
 * That slightly overstates exposure on partially-paid installments, in
 * exchange for a matrix that is deterministic — re-running the same
 * from/to window next month produces the same numbers.
 *
 * ── Terminal states and new entrants ───────────────────────────────────
 *
 * A loan that left the book between the dates is a transition too, not a
 * dropped row: `writtenOffAt <= to` lands in the WRITTEN_OFF column,
 * `closedAt <= to` (or every installment paid in full by `to`) in CLOSED.
 * A RESTRUCTURED original counts as CLOSED — the restructure stamps
 * `closedAt` when it settles the old balance onto the replacement loan,
 * and the replacement shows up as a NEW entrant when disbursed in-window.
 *
 * A loan disbursed after `from` has no origin band, and hiding it would
 * hide growth: it appears on the honest "NEW" origin row, whose amount is
 * its outstanding at `to` (there is no `from` exposure to report).
 */

import {
  AGING_BUCKETS,
  agingBucketFor,
  round2,
  type AgingBucket,
} from "./reports";

const DAY_MS = 86_400_000;

/** What the repository supplies per loan. `totalDue` is the GROSS contractual amount. */
export interface LoanForRollRate {
  loanId: string;
  loanNumber: string;
  productCode: string;
  disbursedAt: Date | null;
  closedAt: Date | null;
  writtenOffAt: Date | null;
  schedule: Array<{
    dueDate: Date;
    totalDue: number;
    paidInFullAt: Date | null;
  }>;
}

export type RollRateOrigin = AgingBucket | "NEW";
export type RollRateDestination = AgingBucket | "CLOSED" | "WRITTEN_OFF";

/** Row order. Derived from AGING_BUCKETS so a new band cannot be missed. */
export const ROLL_RATE_ORIGINS: readonly RollRateOrigin[] = [
  ...AGING_BUCKETS,
  "NEW",
];

/** Column order — the seven bands plus the two ways off the book. */
export const ROLL_RATE_DESTINATIONS: readonly RollRateDestination[] = [
  ...AGING_BUCKETS,
  "CLOSED",
  "WRITTEN_OFF",
];

export interface RollRateCell {
  destination: RollRateDestination;
  /** Loans that moved origin → destination. */
  count: number;
  /**
   * Exposure that moved: the loans' gross outstanding at `from`
   * (at `to` for the NEW origin row, which has no `from` exposure).
   */
  amount: number;
  /** count / origin row's loanCount. 0 when the row is empty. */
  countFraction: number;
  /** amount / origin row's amount. 0 when the row's amount is 0. */
  amountFraction: number;
}

export interface RollRateMatrixRow {
  origin: RollRateOrigin;
  /** Loans in this origin band at `from` (or new entrants, for NEW). */
  loanCount: number;
  amount: number;
  /** One cell per entry of `destinations`, in that order. */
  cells: RollRateCell[];
}

export interface RollRateReport {
  from: string;
  to: string;
  /** Loans that produced a transition (on book at `from`, or entered by `to`). */
  totalLoans: number;
  origins: readonly RollRateOrigin[];
  destinations: readonly RollRateDestination[];
  overall: RollRateMatrixRow[];
  /**
   * The same matrix per product. Product is the one §30 breakdown shipped:
   * it exists on every loan. Branch does not exist in this schema, and
   * collector assignment has no as-of-`from` history — see the doc.
   */
  byProduct: Array<{ productCode: string; rows: RollRateMatrixRow[] }>;
}

/** A loan's position at one instant. */
export type RollRateState =
  | { kind: "ABSENT" }
  | { kind: "CLOSED" }
  | { kind: "WRITTEN_OFF" }
  | { kind: "BAND"; bucket: AgingBucket; outstanding: number };

/**
 * Rebuild one loan's state as of `asOf`. Exported for tests — this is
 * where the past-reconstruction property lives.
 */
export function rollRateStateAt(
  loan: LoanForRollRate,
  asOf: Date,
): RollRateState {
  const t = asOf.getTime();
  if (loan.writtenOffAt && loan.writtenOffAt.getTime() <= t) {
    return { kind: "WRITTEN_OFF" };
  }
  if (loan.closedAt && loan.closedAt.getTime() <= t) {
    return { kind: "CLOSED" };
  }
  if (!loan.disbursedAt || loan.disbursedAt.getTime() > t) {
    return { kind: "ABSENT" };
  }

  // The reconstruction: unpaid at asOf ⇔ not yet marked paid, or marked
  // paid LATER than asOf. A payment dated after the snapshot must not
  // count as paid in it.
  const unpaid = loan.schedule.filter(
    (r) => !r.paidInFullAt || r.paidInFullAt.getTime() > t,
  );
  // Everything settled by asOf but closedAt not (yet) stamped that early:
  // the book position is closed regardless of the stamp.
  if (unpaid.length === 0) return { kind: "CLOSED" };

  let outstanding = 0;
  let earliestOverdue: Date | null = null;
  for (const r of unpaid) {
    outstanding = round2(outstanding + r.totalDue);
    // Same strict `<` as buildAgingReport: due today is not overdue yet.
    if (r.dueDate.getTime() < t) {
      if (!earliestOverdue || r.dueDate < earliestOverdue) {
        earliestOverdue = r.dueDate;
      }
    }
  }
  const daysOverdue = earliestOverdue
    ? Math.max(0, Math.floor((t - earliestOverdue.getTime()) / DAY_MS))
    : 0;
  return { kind: "BAND", bucket: agingBucketFor(daysOverdue), outstanding };
}

interface Transition {
  origin: RollRateOrigin;
  destination: RollRateDestination;
  productCode: string;
  amount: number;
}

function transitionOf(
  loan: LoanForRollRate,
  from: Date,
  to: Date,
): Transition | null {
  const a = rollRateStateAt(loan, from);
  const b = rollRateStateAt(loan, to);

  // Already off the book before the window opened — no transition.
  if (a.kind === "CLOSED" || a.kind === "WRITTEN_OFF") return null;
  // Never on the book inside the window.
  if (a.kind === "ABSENT" && b.kind === "ABSENT") return null;
  // Present at `from` yet absent at `to` cannot be derived from surviving
  // rows (a deleted loan takes its schedule with it) — skip defensively.
  if (b.kind === "ABSENT") return null;

  const origin: RollRateOrigin = a.kind === "BAND" ? a.bucket : "NEW";
  const destination: RollRateDestination =
    b.kind === "BAND" ? b.bucket : b.kind;
  const amount =
    a.kind === "BAND" ? a.outstanding : b.kind === "BAND" ? b.outstanding : 0;
  return { origin, destination, productCode: loan.productCode, amount };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function buildMatrix(transitions: Transition[]): RollRateMatrixRow[] {
  const byPair = new Map<string, { count: number; amount: number }>();
  for (const t of transitions) {
    // `->` rather than a NUL separator. NUL is the usual trick for a
    // composite key because it cannot appear in the parts — but it also
    // makes this whole FILE binary to grep and ripgrep, which costs
    // every future reader their search for one line's safety. Both
    // halves are fixed enum identifiers, so `->` is exactly as
    // collision-proof and leaves the file readable.
    const key = `${t.origin}->${t.destination}`;
    let cell = byPair.get(key);
    if (!cell) {
      cell = { count: 0, amount: 0 };
      byPair.set(key, cell);
    }
    cell.count += 1;
    cell.amount = round2(cell.amount + t.amount);
  }

  return ROLL_RATE_ORIGINS.map((origin) => {
    const raw = ROLL_RATE_DESTINATIONS.map((destination) => {
      const cell = byPair.get(`${origin}->${destination}`);
      return {
        destination,
        count: cell?.count ?? 0,
        amount: cell?.amount ?? 0,
      };
    });
    const loanCount = raw.reduce((s, c) => s + c.count, 0);
    const amount = round2(raw.reduce((s, c) => s + c.amount, 0));
    return {
      origin,
      loanCount,
      amount,
      cells: raw.map((c) => ({
        ...c,
        countFraction: loanCount ? round4(c.count / loanCount) : 0,
        amountFraction: amount ? round4(c.amount / amount) : 0,
      })),
    };
  });
}

/**
 * Fold loans into the matrix one at a time.
 *
 * Exists so the repository can walk the book in bounded chunks instead of
 * materializing every loan — and every loan's whole schedule — before the
 * first transition is derived (finding F4,
 * docs/modernization/query-performance.md). A loan reduces to at most one
 * `Transition` the moment it arrives, so the accumulator holds one small
 * record per loan rather than the schedule rows it was derived from.
 *
 * `buildRollRateReport` is implemented on top of this, so there is exactly
 * one definition of what the matrix means and the chunked caller cannot
 * drift from the whole-array one.
 */
export interface RollRateAccumulator {
  /** Fold one loan. Loans that produced no transition are ignored. */
  add(loan: LoanForRollRate): void;
  /** Assemble the report from everything added so far. */
  finish(): RollRateReport;
}

export function createRollRateAccumulator(
  from: Date,
  to: Date,
): RollRateAccumulator {
  const transitions: Transition[] = [];

  return {
    add(loan) {
      const t = transitionOf(loan, from, to);
      if (t) transitions.push(t);
    },
    finish() {
      const byProductMap = new Map<string, Transition[]>();
      for (const t of transitions) {
        const list = byProductMap.get(t.productCode);
        if (list) list.push(t);
        else byProductMap.set(t.productCode, [t]);
      }

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        totalLoans: transitions.length,
        origins: ROLL_RATE_ORIGINS,
        destinations: ROLL_RATE_DESTINATIONS,
        overall: buildMatrix(transitions),
        byProduct: [...byProductMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([productCode, list]) => ({
            productCode,
            rows: buildMatrix(list),
          })),
      };
    },
  };
}

/**
 * The §30 matrix: for each band at `from`, where that band's loans landed
 * at `to`, as counts, gross amounts, and row-normalized fractions.
 *
 * Every non-empty origin row's countFractions sum to 1 (± rounding to
 * 4 dp): every loan on the row lands in exactly one destination.
 */
export function buildRollRateReport(
  loans: LoanForRollRate[],
  from: Date,
  to: Date,
): RollRateReport {
  const acc = createRollRateAccumulator(from, to);
  for (const loan of loans) acc.add(loan);
  return acc.finish();
}
