/**
 * Product profitability (§54) — per loan product over a period: what it
 * earned, what it lost, and what is left.
 *
 * Pure, like the other builders in this package: the repository fetches
 * journal entries + loan→product references, this computes. No DB here.
 *
 * ── Attribution ────────────────────────────────────────────────────────
 *
 * Journal entries are not tagged by product. What they ARE tagged by is
 * the `(source, sourceRefType, sourceRefId)` convention every auto-posted
 * entry carries (posting.ts) — the same tuple the idempotency index and
 * the reconciliation checks already rely on. Each ref type points at a
 * row that knows its loan, and the loan knows its product:
 *
 *   LoanApplication / LoanWriteOff / LoanPreTermination /
 *   LoanRestructure / AgentCommission   → sourceRefId IS the loan id
 *   LoanPayment                         → LoanPayment.loanId
 *   LoanScheduleAccrual                 → LoanSchedule.loanId
 *   LoanScheduleLateFee                 → "<scheduleId>:<period>" → loanId
 *   PenaltyWaiver                       → PenaltyWaiver.loanId
 *   RepossessionCase                    → RepossessionCase.loanId
 *   JournalEntry (a REVERSAL)           → the reversed entry's attribution
 *
 * The repository performs those lookups in bulk and hands this builder
 * entries with `loanId` already resolved (null when nothing claims the
 * entry). REVERSAL entries are the exception: they are resolved HERE, by
 * following `sourceRefId` to the reversed entry in the input set, so a
 * reversal inherits both the loan and the classification of what it
 * backs out — a reversed late-fee accrual reduces late-fee income, not
 * generic fee income, and a reversal pair inside the window cancels to
 * zero instead of double-counting (§12).
 *
 * Entries that touch the in-scope accounts and still resolve to no
 * product are NOT dropped: they land in the `unattributed` bucket, and
 * the portfolio totals include them (§28's discipline — a manual entry
 * someone typed against Interest Income is money the report must answer
 * for, even when it cannot say which product earned it).
 *
 * ── What the figures are ───────────────────────────────────────────────
 *
 *   interestIncome  4000 credits − debits
 *   feeIncome       4100 credits − debits, EXCEPT late-fee entries
 *   lateFeeIncome   4100 credits − debits where the (effective) source is
 *                   LATE_FEE_ACCRUAL or PENALTY_WAIVE — the chart has no
 *                   separate late-fee account; late fees post to 4100 and
 *                   are told apart by entry source. Waivers debit 4100
 *                   (PENALTY_WAIVE), so they show up here as reductions.
 *   writeOffLoss    5000 debits − credits (full write-offs, restructure
 *                   write-downs, repossession auction deficiencies)
 *   net             interestIncome + feeIncome + lateFeeIncome − writeOffLoss
 *
 * ── Explicitly out of scope ────────────────────────────────────────────
 *
 * This report states what the ledger can attribute, and nothing more:
 *
 *   • Cost of funds — the book records no funding rate or transfer
 *     pricing; any figure here would be invented.
 *   • Operating-cost allocation — Operating Expense (5100) entries carry
 *     no loan or product reference; allocating them needs a driver
 *     (headcount, volume) this system does not record.
 *   • Agent commissions (5150) — attributable per loan, but an
 *     origination cost with its own payable lifecycle; folding it into a
 *     five-figure earnings view was deliberately not done here.
 *   • Bad-debt recoveries (4300) — recognized against loans already
 *     written off. The chart keeps recoveries apart from other income so
 *     the recovery ratio stays readable (see chart.ts); netting them
 *     against `writeOffLoss` would erase that. A natural extension, not
 *     a silent inclusion.
 *   • ECL impairment (5050) — provisioned at portfolio level (EclRun),
 *     not per loan, so per-product attribution does not exist.
 *
 * ── Arithmetic (§11) ───────────────────────────────────────────────────
 *
 * Amounts arrive as the exact decimal strings Prisma's Decimal(14,2)
 * serializes to, are summed as INTEGER CENTAVOS, and leave as decimal
 * strings again. No float ever touches a peso.
 */

import { ACCOUNT_CODES } from "./chart";

/** The account codes this report reads. Everything else is ignored. */
export const PROFITABILITY_ACCOUNT_CODES: readonly string[] = [
  ACCOUNT_CODES.INTEREST_INCOME, // 4000
  ACCOUNT_CODES.FEE_INCOME, // 4100 (origination, pre-term, late fees)
  ACCOUNT_CODES.BAD_DEBT_EXPENSE, // 5000
];

/**
 * Entry sources whose 4100 lines are LATE-FEE income rather than
 * origination/pre-termination fees. PENALTY_WAIVE debits 4100 to back
 * accrued late fees out, so it belongs to the same bucket with the
 * opposite sign.
 */
const LATE_FEE_SOURCES = new Set(["LATE_FEE_ACCRUAL", "PENALTY_WAIVE"]);

/** "1234.56" | "1234.5" | "1234" | "-12.34" → integer centavos. */
export function toCentavos(amount: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) {
    // Decimal(14,2) cannot produce anything else; if something does,
    // refusing beats silently mis-summing money.
    throw new Error(`Not a money amount: "${amount}"`);
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]) * 100;
  const frac = m[3] ? Number((m[3] + "00").slice(0, 2)) : 0;
  return sign * (whole + frac);
}

/** Integer centavos → "1234.56" (always two decimals, sign preserved). */
export function fromCentavos(centavos: number): string {
  const sign = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${String(whole)}.${frac}`;
}

export interface ProfitabilityLineInput {
  accountCode: string;
  /** Exact decimal string, e.g. "1234.56". */
  debit: string;
  credit: string;
}

export interface ProfitabilityEntryInput {
  entryId: string;
  /** JournalSource, e.g. "LOAN_PAYMENT", "REVERSAL". */
  source: string;
  sourceRefType: string | null;
  /** For REVERSAL entries this is the reversed entry's id. */
  sourceRefId: string | null;
  /**
   * Loan resolved by the repository from the sourceRef conventions;
   * null when the entry maps to no loan (manual entries, EclRun, …).
   * Left null for REVERSAL entries — this builder resolves those by
   * following `sourceRefId` to the reversed entry.
   */
  loanId: string | null;
  /**
   * Whether entryDate falls inside [from, to]. Originals fetched only so
   * an in-window reversal can be classified are passed with `false` (and
   * may carry no lines); their own amounts are never counted.
   */
  inWindow: boolean;
  lines: ProfitabilityLineInput[];
}

export interface LoanProductRef {
  loanId: string;
  productCode: string;
  productName: string;
}

/** All amounts are decimal strings — money never rides as a float. */
export interface ProfitabilityFigures {
  interestIncome: string;
  feeIncome: string;
  lateFeeIncome: string;
  writeOffLoss: string;
  net: string;
}

export interface ProductProfitabilityRow extends ProfitabilityFigures {
  productCode: string;
  productName: string;
  /** Distinct loans that contributed at least one in-window entry. */
  loanCount: number;
}

export interface ProductProfitabilityReport {
  from: string;
  to: string;
  products: ProductProfitabilityRow[];
  /**
   * In-scope money no loan/product claims — reported, never dropped.
   * `entryCount` says how many in-window entries landed here, so a
   * nonzero bucket is traceable back to the journal.
   */
  unattributed: ProfitabilityFigures & { entryCount: number };
  /** Portfolio totals — the product rows PLUS the unattributed bucket. */
  totals: ProfitabilityFigures;
}

interface Accumulator {
  interest: number;
  fee: number;
  lateFee: number;
  writeOff: number;
  loanIds: Set<string>;
}

function newAccumulator(): Accumulator {
  return { interest: 0, fee: 0, lateFee: 0, writeOff: 0, loanIds: new Set() };
}

function figuresOf(a: Accumulator): ProfitabilityFigures {
  return {
    interestIncome: fromCentavos(a.interest),
    feeIncome: fromCentavos(a.fee),
    lateFeeIncome: fromCentavos(a.lateFee),
    writeOffLoss: fromCentavos(a.writeOff),
    net: fromCentavos(a.interest + a.fee + a.lateFee - a.writeOff),
  };
}

/**
 * The §54 report: per product, what the ledger attributes to it over
 * [from, to] — income by kind, write-off losses, and the net; plus the
 * unattributed remainder and portfolio totals.
 */
export function buildProductProfitabilityReport(
  entries: ProfitabilityEntryInput[],
  loans: LoanProductRef[],
  from: Date,
  to: Date,
): ProductProfitabilityReport {
  const byId = new Map(entries.map((e) => [e.entryId, e]));
  const productByLoan = new Map(loans.map((l) => [l.loanId, l]));

  const byProduct = new Map<string, Accumulator & { productName: string }>();
  const unattributed = newAccumulator();
  let unattributedEntries = 0;

  for (const entry of entries) {
    if (!entry.inWindow) continue;

    // A reversal inherits the attribution AND the classification of the
    // entry it backs out (§12). The original may be outside the window —
    // the repository supplies it lines-free just for this lookup — or
    // missing entirely, in which case the reversal is honestly
    // unattributable rather than guessed at.
    let effectiveLoanId = entry.loanId;
    let effectiveSource = entry.source;
    if (entry.source === "REVERSAL") {
      const original = entry.sourceRefId
        ? byId.get(entry.sourceRefId)
        : undefined;
      effectiveLoanId = original?.loanId ?? null;
      effectiveSource = original?.source ?? entry.source;
    }

    const product = effectiveLoanId
      ? productByLoan.get(effectiveLoanId)
      : undefined;

    let target: Accumulator;
    if (product) {
      let acc = byProduct.get(product.productCode);
      if (!acc) {
        acc = { ...newAccumulator(), productName: product.productName };
        byProduct.set(product.productCode, acc);
      }
      target = acc;
    } else {
      target = unattributed;
    }

    let touched = false;
    for (const line of entry.lines) {
      const debit = toCentavos(line.debit);
      const credit = toCentavos(line.credit);
      switch (line.accountCode) {
        case ACCOUNT_CODES.INTEREST_INCOME:
          target.interest += credit - debit;
          touched = true;
          break;
        case ACCOUNT_CODES.FEE_INCOME:
          // Without a resolvable source (a reversal whose original is
          // gone) the 4100 line defaults to the generic fee bucket —
          // the amount is still reported, just not late-fee-labelled.
          if (LATE_FEE_SOURCES.has(effectiveSource)) {
            target.lateFee += credit - debit;
          } else {
            target.fee += credit - debit;
          }
          touched = true;
          break;
        case ACCOUNT_CODES.BAD_DEBT_EXPENSE:
          target.writeOff += debit - credit;
          touched = true;
          break;
        default:
          // Cash / receivable / … legs of the same entries — not this
          // report's business. The repository already filters, but a
          // caller passing whole entries must not corrupt the figures.
          break;
      }
    }

    if (touched) {
      if (product && effectiveLoanId) target.loanIds.add(effectiveLoanId);
      if (!product) unattributedEntries += 1;
    }
  }

  const products: ProductProfitabilityRow[] = [...byProduct.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productCode, acc]) => ({
      productCode,
      productName: acc.productName,
      loanCount: acc.loanIds.size,
      ...figuresOf(acc),
    }));

  const totals: Accumulator = newAccumulator();
  for (const acc of [...byProduct.values(), unattributed]) {
    totals.interest += acc.interest;
    totals.fee += acc.fee;
    totals.lateFee += acc.lateFee;
    totals.writeOff += acc.writeOff;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    products,
    unattributed: {
      ...figuresOf(unattributed),
      entryCount: unattributedEntries,
    },
    totals: figuresOf(totals),
  };
}
