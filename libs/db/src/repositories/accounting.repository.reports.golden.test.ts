import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  type LedgerFixture,
  inMemoryLedger,
} from "../testing/in-memory-ledger";
import { AccountingRepository } from "./accounting.repository";

/**
 * GOLDEN TESTS — trial balance, balance sheet, account balance.
 *
 * Written against the CURRENT implementation and committed passing BEFORE
 * the F3 refactor (docs/modernization/query-performance.md), per §81. They
 * pin the numbers the reports produce today so that moving the summation
 * from JavaScript into a SQL `groupBy` can be proven not to have moved a
 * single centavo.
 *
 * What the current implementation computes, exactly:
 *
 *   `ledgerLines({from,to})` selects every `JournalLine` whose entry falls in
 *   the window — with no window at all for `trialBalance`/`balanceSheet`,
 *   which pass only `{to: asOf}` — hydrates each with its `Account`, and hands
 *   the flat list to the pure builders in libs/accounting/src/reports.ts.
 *
 *   `buildTrialBalance` folds per account with `row.net = round2(row.net +
 *   (debit - credit))` — note the rounding happens **after every line**, not
 *   once at the end. An account whose net is >= 0 is shown in the debit
 *   column and 0 in the credit column; negative nets flip to the credit
 *   column as a positive number.
 *
 *   `buildBalanceSheet` folds INCOME and EXPENSE lines into a single running
 *   `retainedEarnings` accumulator (again rounding per line) and everything
 *   else per account, signing by account type / normal balance.
 *
 *   `accountBalance` sums `Number(debit) - Number(credit)` over one account's
 *   lines in float with **no** per-line rounding, and its two callers round
 *   the result at the end.
 *
 * The edge cases the brief named are all present in the fixture below:
 *   - a NEGATIVE balance (1900 Suspense, credited only),
 *   - an account with NO LINES at all (1950), which must stay absent from the
 *     reports and read as 0 — the case where Postgres' `SUM` returns NULL,
 *   - a REVERSAL PAIR (E3 reversed by E5), which must leave both legs present
 *     in the fold and net to zero rather than vanishing.
 *
 * Values are stated as exact 2-decimal strings because that is what
 * `Decimal(14,2)` stores; the numbers below were computed by hand from the
 * fixture and then confirmed against the unmodified implementation.
 */

const AS_OF = new Date("2026-06-30T23:59:59.999Z");

const FIXTURE: LedgerFixture = {
  accounts: [
    {
      id: "acc-cash",
      code: "1000",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    {
      id: "acc-ar",
      code: "1100",
      name: "Loans Receivable",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    {
      id: "acc-susp",
      code: "1900",
      name: "Suspense",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    // Deliberately has no journal lines anywhere in the fixture.
    {
      id: "acc-unused",
      code: "1950",
      name: "Unused Clearing",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    {
      id: "acc-ap",
      code: "2000",
      name: "Accounts Payable",
      type: "LIABILITY",
      normalBalance: "CREDIT",
    },
    {
      id: "acc-cap",
      code: "3000",
      name: "Owner Capital",
      type: "EQUITY",
      normalBalance: "CREDIT",
    },
    {
      id: "acc-fee",
      code: "4100",
      name: "Fee Income",
      type: "INCOME",
      normalBalance: "CREDIT",
    },
    {
      id: "acc-exp",
      code: "5000",
      name: "Operating Expense",
      type: "EXPENSE",
      normalBalance: "DEBIT",
    },
  ],
  entries: [
    entry("E1", "2026-01-15", "MANUAL"),
    entry("E2", "2026-02-10", "DISBURSEMENT"),
    entry("E3", "2026-03-05", "LATE_FEE_ACCRUAL"),
    entry("E4", "2026-03-06", "LATE_FEE_ACCRUAL"),
    entry("E5", "2026-04-01", "MANUAL"), // reverses E3
    entry("E6", "2026-05-02", "MANUAL"),
    entry("E7", "2026-06-01", "MANUAL"),
    // Outside the as-of window; must not appear in any figure below.
    entry("E8", "2026-12-01", "MANUAL"),
  ],
  lines: [
    line("L1", "E1", "acc-cash", "50000.00", "0.00"),
    line("L2", "E1", "acc-cap", "0.00", "50000.00"),

    line("L3", "E2", "acc-ar", "20000.00", "0.00"),
    line("L4", "E2", "acc-cash", "0.00", "20000.00"),

    line("L5", "E3", "acc-ar", "133.33", "0.00"),
    line("L6", "E3", "acc-fee", "0.00", "133.33"),

    line("L7", "E4", "acc-ar", "66.67", "0.00"),
    line("L8", "E4", "acc-fee", "0.00", "66.67"),

    // The reversal of E3 — both legs stay on the books.
    line("L9", "E5", "acc-fee", "133.33", "0.00"),
    line("L10", "E5", "acc-ar", "0.00", "133.33"),

    line("L11", "E6", "acc-exp", "1250.75", "0.00"),
    line("L12", "E6", "acc-ap", "0.00", "1250.75"),

    // Only ever credited, so its balance is negative.
    line("L13", "E7", "acc-cash", "500.00", "0.00"),
    line("L14", "E7", "acc-susp", "0.00", "500.00"),

    line("L15", "E8", "acc-cash", "999999.99", "0.00"),
    line("L16", "E8", "acc-cap", "0.00", "999999.99"),
  ],
};

function entry(
  id: string,
  date: string,
  source: string,
): LedgerFixture["entries"][number] {
  return {
    id,
    number: `JE-2026-${id}`,
    entryDate: new Date(`${date}T00:00:00.000Z`),
    source,
    sourceRefType: null,
    sourceRefId: null,
    memo: null,
  };
}

function line(
  id: string,
  entryId: string,
  accountId: string,
  debit: string,
  credit: string,
): LedgerFixture["lines"][number] {
  return { id, entryId, accountId, debit, credit };
}

function repo(): { repo: AccountingRepository; prisma: PrismaClient } {
  const { prisma } = inMemoryLedger(FIXTURE);
  return { repo: new AccountingRepository(prisma), prisma };
}

describe("GOLDEN — trialBalance", () => {
  it("produces exactly these rows and totals", async () => {
    const { repo: r } = repo();
    const tb = await r.trialBalance(AS_OF);

    /*
     * `net` is asserted deliberately. It is an internal accumulator that
     * `buildTrialBalance` spreads into the emitted row (`{...r, debit,
     * credit}`) even though `TrialBalanceRow` does not declare it — so it
     * reaches API consumers. Pinning it here means the refactor cannot
     * silently add or drop it.
     */
    expect(tb.rows).toEqual([
      {
        accountId: "acc-cash",
        code: "1000",
        name: "Cash",
        type: "ASSET",
        debit: 30500,
        credit: 0,
        net: 30500,
      },
      {
        accountId: "acc-ar",
        code: "1100",
        name: "Loans Receivable",
        type: "ASSET",
        debit: 20066.67,
        credit: 0,
        net: 20066.67,
      },
      // Negative net flips to the credit column as a positive number.
      {
        accountId: "acc-susp",
        code: "1900",
        name: "Suspense",
        type: "ASSET",
        debit: 0,
        credit: 500,
        net: -500,
      },
      {
        accountId: "acc-ap",
        code: "2000",
        name: "Accounts Payable",
        type: "LIABILITY",
        debit: 0,
        credit: 1250.75,
        net: -1250.75,
      },
      {
        accountId: "acc-cap",
        code: "3000",
        name: "Owner Capital",
        type: "EQUITY",
        debit: 0,
        credit: 50000,
        net: -50000,
      },
      // 133.33 + 66.67 credited, 133.33 debited back by the reversal.
      {
        accountId: "acc-fee",
        code: "4100",
        name: "Fee Income",
        type: "INCOME",
        debit: 0,
        credit: 66.67,
        net: -66.67,
      },
      {
        accountId: "acc-exp",
        code: "5000",
        name: "Operating Expense",
        type: "EXPENSE",
        debit: 1250.75,
        credit: 0,
        net: 1250.75,
      },
    ]);

    expect(tb.totalDebit).toBe(51817.42);
    expect(tb.totalCredit).toBe(51817.42);
    expect(tb.inBalance).toBe(true);
    expect(tb.asOf).toBe(AS_OF.toISOString());
  });

  it("omits an account that has no journal lines", async () => {
    const { repo: r } = repo();
    const tb = await r.trialBalance(AS_OF);
    expect(tb.rows.map((x) => x.code)).not.toContain("1950");
    expect(tb.rows).toHaveLength(7);
  });

  it("excludes entries dated after the as-of date", async () => {
    const { repo: r } = repo();
    const tb = await r.trialBalance(AS_OF);
    const cash = tb.rows.find((x) => x.code === "1000");
    // 999,999.99 from E8 (2026-12-01) must not be in here.
    expect(cash?.debit).toBe(30500);
  });

  it("keeps a reversal pair visible as two legs netting to zero", async () => {
    // A late fee of 133.33 accrued (E3) and reversed in full (E5); a second
    // accrual of 66.67 (E4) was not reversed. The fee account must therefore
    // read 66.67 — not 200.00, and not 0.
    const { repo: r } = repo();
    const tb = await r.trialBalance(AS_OF);
    expect(tb.rows.find((x) => x.code === "4100")?.credit).toBe(66.67);
  });
});

describe("GOLDEN — balanceSheet", () => {
  it("produces exactly these sections, retained earnings and totals", async () => {
    const { repo: r } = repo();
    const bs = await r.balanceSheet(AS_OF);

    expect(bs.assets).toEqual({
      rows: [
        { code: "1000", name: "Cash", amount: 30500 },
        { code: "1100", name: "Loans Receivable", amount: 20066.67 },
        // Negative asset balances stay negative on the balance sheet.
        { code: "1900", name: "Suspense", amount: -500 },
      ],
      total: 50066.67,
    });

    expect(bs.liabilities).toEqual({
      rows: [{ code: "2000", name: "Accounts Payable", amount: 1250.75 }],
      total: 1250.75,
    });

    expect(bs.equity).toEqual({
      rows: [{ code: "3000", name: "Owner Capital", amount: 50000 }],
      total: 50000,
    });

    // Income 66.67 (net of the reversal) less expense 1,250.75.
    expect(bs.retainedEarnings).toBe(-1184.08);
    expect(bs.totalLiabilitiesAndEquity).toBe(50066.67);
    expect(bs.inBalance).toBe(true);
    expect(bs.asOf).toBe(AS_OF.toISOString());
  });

  it("omits an account with no lines from every section", async () => {
    const { repo: r } = repo();
    const bs = await r.balanceSheet(AS_OF);
    const codes = [
      ...bs.assets.rows,
      ...bs.liabilities.rows,
      ...bs.equity.rows,
    ].map((x) => x.code);
    expect(codes).not.toContain("1950");
  });
});

describe("GOLDEN — accountBalance", () => {
  /** `accountBalance` is private; the reports it feeds are the public surface. */
  const balanceOf = (r: AccountingRepository, accountId: string) =>
    (
      r as unknown as {
        accountBalance: (id: string, asOf: Date) => Promise<number>;
      }
    ).accountBalance(accountId, AS_OF);

  it("sums a positive debit-normal account", async () => {
    const { repo: r } = repo();
    expect(await balanceOf(r, "acc-ar")).toBe(20066.67);
  });

  it("returns a negative number for a credit-only account", async () => {
    const { repo: r } = repo();
    expect(await balanceOf(r, "acc-susp")).toBe(-500);
  });

  it("returns 0 for an account with no lines", async () => {
    // The SUM-over-zero-rows case: Postgres returns NULL here, and the
    // caller must still see 0.
    const { repo: r } = repo();
    expect(await balanceOf(r, "acc-unused")).toBe(0);
  });

  it("nets a reversal pair — pinning today's float drift exactly", async () => {
    /*
     * NOT a typo, and not a value anyone should be pleased with.
     *
     * `accountBalance` accumulates `Number(debit) - Number(credit)` in IEEE
     * doubles and, alone among these functions, never rounds. Over this
     * fixture that lands on -66.66999999999999 rather than -66.67:
     *
     *   0 - 133.33      = -133.33
     *     - 66.67       = -200
     *     + 133.33      = -66.66999999999999
     *
     * That is the number the current implementation returns, so that is what
     * a golden test has to say. Both production callers (`portfolioSummary`,
     * for cash and receivable) wrap it in `round2`, so the drift is invisible
     * downstream — see the assertion below, which is the value that actually
     * reaches a caller and which must survive the F3 refactor untouched.
     */
    const { repo: r } = repo();
    const raw = await balanceOf(r, "acc-fee");
    expect(raw).toBe(-66.66999999999999);
    expect(Math.round(raw * 100) / 100).toBe(-66.67);
  });

  it("respects the as-of cutoff", async () => {
    const { repo: r } = repo();
    // Excludes E8's 999,999.99.
    expect(await balanceOf(r, "acc-cash")).toBe(30500);
  });
});

/**
 * `incomeStatement` shares `ledgerLines` with the two reports above, so it
 * moves whenever they do even though F3 does not name it. Pinned for the same
 * reason and at the same time.
 */
describe("GOLDEN — incomeStatement", () => {
  const FROM = new Date("2026-01-01T00:00:00.000Z");

  it("produces exactly these sections over the full window", async () => {
    const { repo: r } = repo();
    const is = await r.incomeStatement(FROM, AS_OF);

    expect(is.income).toEqual({
      rows: [{ code: "4100", name: "Fee Income", amount: 66.67 }],
      total: 66.67,
    });
    expect(is.expense).toEqual({
      rows: [{ code: "5000", name: "Operating Expense", amount: 1250.75 }],
      total: 1250.75,
    });
    expect(is.netIncome).toBe(-1184.08);
    expect(is.from).toBe(FROM.toISOString());
    expect(is.to).toBe(AS_OF.toISOString());
  });

  it("bounds both ends of the window", async () => {
    // March only: the two fee accruals (E3, E4), and neither the April
    // reversal nor the May expense.
    const { repo: r } = repo();
    const is = await r.incomeStatement(
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-31T23:59:59.999Z"),
    );
    expect(is.income.total).toBe(200);
    expect(is.expense.total).toBe(0);
    expect(is.expense.rows).toEqual([]);
    expect(is.netIncome).toBe(200);
  });

  it("ignores balance-sheet accounts entirely", async () => {
    const { repo: r } = repo();
    const is = await r.incomeStatement(FROM, AS_OF);
    const codes = [...is.income.rows, ...is.expense.rows].map((x) => x.code);
    expect(codes).toEqual(["4100", "5000"]);
  });

  it("returns empty sections for a window with no entries", async () => {
    const { repo: r } = repo();
    const is = await r.incomeStatement(
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2025-12-31T23:59:59.999Z"),
    );
    expect(is.income).toEqual({ rows: [], total: 0 });
    expect(is.expense).toEqual({ rows: [], total: 0 });
    expect(is.netIncome).toBe(0);
  });
});
