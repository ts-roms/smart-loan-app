import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { runReconciliation } from "./reconciliation";

/**
 * The reconciliation job's own tests.
 *
 * Two properties matter more than coverage here:
 *
 *   1. It must FAIL when the books are wrong. A check that cannot fail
 *      is decoration.
 *   2. It must PASS when they are right. A job that cries wolf gets
 *      muted, and a muted reconciliation is worse than none — it looks
 *      like assurance and provides none.
 *
 * The late-fee term in the receivable check exists entirely for (2):
 * late-fee accrual debits Loans Receivable without touching
 * principalDue, so any book with an overdue account would report a
 * false difference without it.
 */

interface Fixture {
  lineTotals?: { debit: number; credit: number };
  unbalancedEntries?: { number: string; debit: number; credit: number }[];
  duplicateRefs?: unknown[];
  badSchedule?: unknown[];
  receivable?: { debit: number; credit: number };
  schedule?: { principalDue: number; principalPaid: number };
  lateFees?: { debit: number; credit: number };
  waives?: { debit: number; credit: number };
}

/** Prisma stand-in returning whatever the scenario declares. */
function fakePrisma(f: Fixture) {
  const zero = { debit: 0, credit: 0 };
  let aggCall = 0;
  return {
    journalLine: {
      aggregate: ({ where }: { where?: { entry?: { source?: string } } }) => {
        // Order matters: the receivable check fires four aggregates —
        // GL, (schedule is separate), late fees, waives — and the
        // trial balance fires one with no `where`.
        if (!where) {
          aggCall += 1;
          return Promise.resolve({ _sum: f.lineTotals ?? zero });
        }
        const source = where.entry?.source;
        if (source === "LATE_FEE_ACCRUAL")
          return Promise.resolve({ _sum: f.lateFees ?? zero });
        if (source === "PENALTY_WAIVE")
          return Promise.resolve({ _sum: f.waives ?? zero });
        return Promise.resolve({ _sum: f.receivable ?? zero });
      },
    },
    loanSchedule: {
      aggregate: () =>
        Promise.resolve({
          _sum: f.schedule ?? { principalDue: 0, principalPaid: 0 },
        }),
    },
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes("HAVING ABS"))
        return Promise.resolve(f.unbalancedEntries ?? []);
      if (sql.includes("sourceRefId"))
        return Promise.resolve(f.duplicateRefs ?? []);
      return Promise.resolve(f.badSchedule ?? []);
    },
    __aggCall: () => aggCall,
  } as unknown as PrismaClient;
}

const check = (
  r: Awaited<ReturnType<typeof runReconciliation>>,
  name: string,
) => r.checks.find((c) => c.name === name)!;

describe("runReconciliation — passes on a healthy ledger", () => {
  it("reports ok when everything ties", async () => {
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        receivable: { debit: 500, credit: 200 },
        schedule: { principalDue: 500, principalPaid: 200 },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(5);
  });

  it("tolerates a centavo of rounding", async () => {
    // Thousands of two-decimal rows legitimately land a centavo out.
    // Failing on that would mute the job within a week.
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000.01, credit: 1_000 },
        receivable: { debit: 300, credit: 0 },
        schedule: { principalDue: 300, principalPaid: 0 },
      }),
    );
    expect(check(r, "trial_balance").ok).toBe(true);
  });

  it("counts accrued late fees as part of the receivable", async () => {
    /*
     * The false positive this job would otherwise produce on any book
     * with an overdue account. Late-fee accrual debits Loans Receivable
     * without adding to principalDue, so the GL legitimately exceeds
     * outstanding principal by the accrued amount.
     */
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        receivable: { debit: 1_250, credit: 0 }, // 1,000 principal + 250 fees
        schedule: { principalDue: 1_000, principalPaid: 0 },
        lateFees: { debit: 250, credit: 0 },
      }),
    );
    expect(check(r, "receivable_subledger").ok).toBe(true);
  });

  it("nets a waived penalty back out", async () => {
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        receivable: { debit: 1_250, credit: 100 }, // 250 accrued, 100 waived
        schedule: { principalDue: 1_000, principalPaid: 0 },
        lateFees: { debit: 250, credit: 0 },
        waives: { debit: 0, credit: 100 },
      }),
    );
    expect(check(r, "receivable_subledger").ok).toBe(true);
  });
});

describe("runReconciliation — fails when the books are wrong", () => {
  it("catches a trial balance that does not tie", async () => {
    const r = await runReconciliation(
      fakePrisma({ lineTotals: { debit: 1_000, credit: 900 } }),
    );
    expect(r.ok).toBe(false);
    const c = check(r, "trial_balance");
    expect(c.ok).toBe(false);
    expect(c.delta).toBe(100);
    expect(c.summary).toMatch(/OUT BY 100/);
  });

  it("catches an individually unbalanced entry", async () => {
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        unbalancedEntries: [
          { number: "JE-2026-000042", debit: 500, credit: 400 },
        ],
      }),
    );
    expect(check(r, "entry_balance").ok).toBe(false);
    expect(check(r, "entry_balance").offenders?.[0]).toMatch(/JE-2026-000042/);
  });

  it("catches a duplicate auto-post", async () => {
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        duplicateRefs: [
          {
            source: "INTEREST_ACCRUAL",
            ref_type: "LoanSchedule",
            ref_id: "s1",
            copies: 2,
          },
        ],
      }),
    );
    expect(check(r, "duplicate_source_refs").ok).toBe(false);
  });

  it("catches impossible instalment progress", async () => {
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        badSchedule: [
          { number: "LN-1", installment: 3, reason: "principal overpaid" },
        ],
      }),
    );
    expect(check(r, "schedule_bounds").ok).toBe(false);
    expect(check(r, "schedule_bounds").offenders?.[0]).toMatch(/LN-1 #3/);
  });

  it("catches a receivable that disagrees with the loan book", async () => {
    /*
     * The real finding, in miniature: the GL had been credited for a
     * written-off loan while its instalments still showed outstanding,
     * so the loan book claimed more was owed than the ledger did.
     */
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 1_000 },
        receivable: { debit: 500, credit: 500 }, // GL says nothing owed
        schedule: { principalDue: 500, principalPaid: 0 }, // book says 500
      }),
    );
    const c = check(r, "receivable_subledger");
    expect(c.ok).toBe(false);
    expect(c.delta).toBe(-500);
    expect(c.summary).toMatch(/outstanding principal 500.00/);
  });

  it("reports every failure, not just the first", async () => {
    // An operator fixing one problem should not have to re-run to find
    // the next.
    const r = await runReconciliation(
      fakePrisma({
        lineTotals: { debit: 1_000, credit: 900 },
        duplicateRefs: [
          {
            source: "INTEREST_ACCRUAL",
            ref_type: null,
            ref_id: "x",
            copies: 3,
          },
        ],
      }),
    );
    expect(r.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
  });
});
