import { ACCOUNT_CODES, DEFAULT_CHART_OF_ACCOUNTS } from "@loan/accounting";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * §26 — the allocation order a payment is applied under, at the repository.
 *
 * The arithmetic of the orders is covered in
 * `@loan/accounting` `posting.allocation-order.test.ts`. What is worth
 * proving HERE is the safety property the design exists for:
 *
 *   An in-flight loan's allocation cannot be changed by editing a product.
 *
 * The mechanism is a snapshot. `LoanApplication.paymentAllocationOrder` is
 * copied from the product when the application is created and is the only
 * thing `recordPayment` reads; `LoanProduct.paymentAllocationOrder` is a
 * default for new applications and nothing more. The strongest way to state
 * that is structural rather than behavioural — the payment path must not
 * touch `LoanProduct` at all — so the double below throws if it does.
 *
 * ── Order-sensitivity, now that it is observable ────────────────────────
 *
 * This file used to close by asserting that all three orders produced
 * identical figures, because `recordPayment` passed no penalty due and
 * there was no per-instalment balance for it to pass. It asked, in as many
 * words, for "a companion test driving a loan with a genuine penalty
 * balance through both orders and pinning the difference" once the balances
 * became real. That is the last block below, and the identity claim it
 * replaces is gone: it is no longer true, and a test asserting it would now
 * be asserting the absence of the feature.
 *
 * What survives from it — narrowed to what is still true and still worth
 * guarding — is the block before it: with NO accrued penalty, all three
 * orders still agree to the centavo. That is the position every loan
 * written before §26 is in, and it is the safety property, not a statement
 * about the tiers being inert.
 *
 * The arithmetic of the orders is covered in `@loan/accounting`
 * `posting.allocation-order.test.ts`; the borrower-level consequences on a
 * real book are in `loan.repository.penalty-collection.golden.test.ts`.
 * What these two blocks add is that `recordPayment` genuinely feeds the
 * allocator the ledger's figures rather than zeros.
 */

const ROWS = [
  { principalDue: "8026.26", interestDue: "750.00" },
  { principalDue: "8146.65", interestDue: "629.61" },
  { principalDue: "8268.85", interestDue: "507.41" },
];

const LOAN_ID = "9c4e7a15-2b83-4f60-91d7-6e0a3c85b2f4";
const OFFICER = "user-order-1";

const ORDERS = [
  "INTEREST_PRINCIPAL",
  "FEES_PENALTIES_INTEREST_PRINCIPAL",
  "INTEREST_PRINCIPAL_FEES_PENALTIES",
] as const;

function money(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return new Prisma.Decimal(v as Prisma.Decimal.Value).toFixed(2);
}

interface Line {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string;
}

class Db {
  loans: Array<Record<string, unknown>> = [];
  schedules: Array<Record<string, unknown>> = [];
  entries: Array<{ sourceRefId: string | null; lines: Line[] }> = [];
  /** Late fee accrued per schedule id, as the ledger would report it. */
  accruals: Array<{ scheduleId: string; amount: string }> = [];
  accounts = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
    id: `acct-${a.code}`,
    code: a.code,
    active: true,
  }));
  periods: Array<{ id: string; year: number; month: number }> = [];
  /** Set if anything reads LoanProduct during a payment. */
  productWasRead = false;
  /** How many LATE_FEE_ACCRUAL prefix lookups the payment path issued. */
  accrualLookups = 0;
  seq = 0;

  next(p: string): string {
    this.seq += 1;
    return `${p}-${this.seq}`;
  }

  inst(no: number): Record<string, unknown> {
    return this.schedules.find((s) => s.installmentNo === no)!;
  }

  credited(code: string): string {
    const id = this.accounts.find((a) => a.code === code)?.id;
    return money(
      this.entries
        .flatMap((e) => e.lines)
        .filter((l) => l.accountId === id)
        .reduce((s, l) => s + l.credit, 0),
    );
  }

  memos(): string[] {
    return this.entries.flatMap((e) => e.lines.map((l) => l.memo ?? ""));
  }
}

function makeClient(db: Db): PrismaClient {
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),

    /*
     * The guard. Nothing on the payment path may consult the product — if
     * it did, editing `LoanProduct.paymentAllocationOrder` would change how
     * every live loan under that product applies its payments, mid-contract.
     */
    loanProduct: {
      findUnique: async () => {
        db.productWasRead = true;
        throw new Error(
          "recordPayment must not read LoanProduct — the loan's own snapshotted order governs",
        );
      },
      findFirst: async () => {
        db.productWasRead = true;
        throw new Error("recordPayment must not read LoanProduct");
      },
    },

    loanApplication: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        db.loans.find((l) => l.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const l = db.loans.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return l;
      },
    },

    loanPayment: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: db.next("pay"),
        ...data,
      }),
    },

    loanSchedule: {
      findMany: async ({ where }: { where: { loanId: string } }) =>
        db.schedules
          .filter((s) => s.loanId === where.loanId && s.paidInFullAt === null)
          .sort(
            (a, b) => (a.installmentNo as number) - (b.installmentNo as number),
          ),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const r = db.schedules.find((s) => s.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      count: async ({
        where,
      }: {
        where: { loanId: string; paidInFullAt?: null };
      }) =>
        db.schedules.filter(
          (s) =>
            s.loanId === where.loanId &&
            (!("paidInFullAt" in where) || s.paidInFullAt === null),
        ).length,
    },

    account: {
      findMany: async ({ where }: { where: { code: { in: string[] } } }) =>
        db.accounts.filter((a) => where.code.in.includes(a.code)),
    },

    accountingPeriod: {
      upsert: async ({
        where,
      }: {
        where: { year_month: { year: number; month: number } };
      }) => {
        const { year, month } = where.year_month;
        let p = db.periods.find((x) => x.year === year && x.month === month);
        if (!p) {
          p = { id: db.next("period"), year, month };
          db.periods.push(p);
        }
        return { ...p, status: "OPEN" };
      },
    },

    journalEntry: {
      findFirst: async () => null,

      /*
       * The accrual lookup `recordPayment` runs for an order that collects
       * penalties. Counted as well as answered: "the legacy order does not
       * read this at all" is a property worth asserting directly.
       */
      findMany: async ({
        where,
      }: {
        where: {
          source?: string;
          sourceRefType?: string;
          OR?: Array<{ sourceRefId: { startsWith: string } }>;
        };
      }) => {
        if (where.source === "LATE_FEE_ACCRUAL") db.accrualLookups += 1;
        return db.accruals
          .filter((a) =>
            (where.OR ?? []).some((o) =>
              `${a.scheduleId}:`.startsWith(o.sourceRefId.startsWith),
            ),
          )
          .map((a) => ({
            sourceRefId: `${a.scheduleId}:2026-04-09`,
            lines: [
              {
                credit: new Prisma.Decimal(a.amount),
                account: { code: "4100" },
              },
            ],
          }));
      },
      create: async ({
        data,
      }: {
        data: Record<string, unknown> & { lines: { create: Line[] } };
      }) => {
        const e = {
          id: db.next("je"),
          sourceRefId: (data.sourceRefId as string) ?? null,
          lines: data.lines.create,
        };
        db.entries.push(e);
        return e;
      },
    },
  };
  return client as unknown as PrismaClient;
}

/** Seeds an ACTIVE loan carrying `order` as its snapshotted allocation order. */
function seed(
  order: (typeof ORDERS)[number],
  accruals: Array<{ scheduleId: string; amount: string }> = [],
): {
  db: Db;
  repo: LoanRepository;
} {
  const db = new Db();
  db.accruals = accruals;
  db.loans.push({
    id: LOAN_ID,
    number: "LN-2026-000077",
    status: "ACTIVE",
    closedAt: null,
    paymentAllocationOrder: order,
  });
  ROWS.forEach((r, i) => {
    db.schedules.push({
      id: `s-${i + 1}`,
      loanId: LOAN_ID,
      installmentNo: i + 1,
      dueDate: new Date(Date.UTC(2026, 3 + i, 1)),
      principalDue: new Prisma.Decimal(r.principalDue),
      interestDue: new Prisma.Decimal(r.interestDue),
      totalDue: new Prisma.Decimal(r.principalDue).plus(r.interestDue),
      principalPaid: new Prisma.Decimal(0),
      interestPaid: new Prisma.Decimal(0),
      penaltyPaid: new Prisma.Decimal(0),
      penaltyWaived: new Prisma.Decimal(0),
      paidInFullAt: null,
    });
  });
  return { db, repo: new LoanRepository(makeClient(db)) };
}

function pay(repo: LoanRepository, amount: string) {
  return repo.recordPayment(LOAN_ID, {
    amount: new Prisma.Decimal(amount) as unknown as number,
    paidOn: new Date(Date.UTC(2026, 3, 5)),
    recordedById: OFFICER,
  });
}

describe("recordPayment — the loan's snapshotted order governs", () => {
  it("never reads LoanProduct, so a product edit cannot reach a live loan", async () => {
    // The structural guarantee. If this ever fails, someone has wired
    // allocation back to the product and every in-flight borrower under
    // that product is one UPDATE away from a different repayment split.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "12000.00");
    expect(db.productWasRead).toBe(false);
  });

  it("accepts a payment on every order the enum allows", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "8776.26");
      expect(db.inst(1).paidInFullAt).not.toBeNull();
      expect(db.productWasRead).toBe(false);
    }
  });

  it("falls back to the legacy order when a row carries none", async () => {
    // Defensive: a fixture or a partially-migrated row with no order must
    // pay the way it always did rather than throwing on a live payment.
    const { db, repo } = seed("INTEREST_PRINCIPAL");
    delete db.loans[0]!.paymentAllocationOrder;

    await pay(repo, "8776.26");
    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("8026.26");
  });
});
describe("a loan with no accrued penalty pays the same under every order", () => {
  /*
   * WHAT THIS BLOCK REPLACED, AND WHY IT IS NARROWER.
   *
   * It used to be called "the new tiers are inert until fee and penalty
   * balances exist" and its comment said `recordPayment` supplies no fee or
   * penalty due because there is no per-instalment balance to supply. That
   * is no longer true — it now supplies both, from the accrual ledger and
   * from `LoanSchedule.penaltyWaived`/`penaltyPaid` — so the reason has
   * been removed and only the surviving fact is asserted: with nothing
   * accrued, every tier resolves to zero and the orders agree.
   *
   * That is the safety property, and it is the one that matters most,
   * because it is the position every loan written before §26 is in. It is
   * checked on this fixture and, as literal peso amounts rather than as an
   * equality between three runs, in
   * `loan.repository.penalty-collection.golden.test.ts`.
   */
  const AMOUNTS = ["5000.00", "8776.26", "12000.00", "30000.00"];

  it("produces identical figures on all three orders", async () => {
    for (const amount of AMOUNTS) {
      const results = [];
      for (const order of ORDERS) {
        const { db, repo } = seed(order);
        await pay(repo, amount);
        results.push({
          interest: db.credited(ACCOUNT_CODES.INTEREST_INCOME),
          receivable: db.credited(ACCOUNT_CODES.LOANS_RECEIVABLE),
          advances: db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES),
          progress: [1, 2, 3].map((n) => [
            money(db.inst(n).interestPaid),
            money(db.inst(n).principalPaid),
            money(db.inst(n).penaltyPaid),
            db.inst(n).paidInFullAt === null,
          ]),
        });
      }
      for (const r of results) expect(r).toEqual(results[0]);
    }
  });

  it("posts no fee or penalty line, on any order", async () => {
    // The journal entry gains Fees/Penalties lines only when the allocation
    // actually applied money to them. Zero balances, zero lines — and the
    // entry still balances.
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "12000.00");

      const memos = db.memos();
      expect(memos.some((m) => m.startsWith("Fees on"))).toBe(false);
      expect(memos.some((m) => m.startsWith("Penalties on"))).toBe(false);

      for (const e of db.entries) {
        const d = e.lines.reduce((s, l) => s + l.debit, 0);
        const c = e.lines.reduce((s, l) => s + l.credit, 0);
        expect(money(d)).toBe(money(c));
      }
    }
  });
});

describe("a real penalty balance reaches the allocator", () => {
  /*
   * The companion this file asked for in as many words when the tiers were
   * still inert: "a companion test driving a loan with a genuine penalty
   * balance through both orders and pinning the difference."
   *
   * 250.00 accrued against instalment 1, in the ledger, exactly as the
   * nightly job would have posted it. Nothing on the schedule row records
   * it — the point is that `recordPayment` goes and reads it.
   */
  const ACCRUED = [{ scheduleId: "s-1", amount: "250.00" }];

  it("§26's order pays the penalty first and 250.00 less principal", async () => {
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL", ACCRUED);
    await pay(repo, "5000.00");

    expect(money(db.inst(1).penaltyPaid)).toBe("250.00");
    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("4000.00");
    expect(db.memos().some((m) => m.startsWith("Penalties on"))).toBe(true);
  });

  it("the legacy order pays exactly what it always did", async () => {
    // Same loan, same ledger, same payment. The tier does not exist in this
    // order, so the accrued 250.00 cannot touch the split.
    const { db, repo } = seed("INTEREST_PRINCIPAL", ACCRUED);
    await pay(repo, "5000.00");

    expect(money(db.inst(1).penaltyPaid)).toBe("0.00");
    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("4250.00");
    expect(db.memos().some((m) => m.startsWith("Penalties on"))).toBe(false);
  });

  it("does not even read the accrual ledger for the legacy order", async () => {
    /*
     * The safety property as work done rather than as arithmetic. An order
     * with no PENALTIES tier can never reduce a penalty, so reading the
     * figure could only change the outcome by accident — and every loan on
     * the books today is on that order, so this is also why none of them
     * pays for the feature in query time.
     */
    const legacy = seed("INTEREST_PRINCIPAL", ACCRUED);
    await pay(legacy.repo, "5000.00");
    expect(legacy.db.accrualLookups).toBe(0);

    const s26 = seed("FEES_PENALTIES_INTEREST_PRINCIPAL", ACCRUED);
    await pay(s26.repo, "5000.00");
    expect(s26.db.accrualLookups).toBe(1);
  });

  it("still never reads LoanProduct, penalty or no penalty", async () => {
    // The file's central guarantee, re-checked on the path that now does
    // strictly more work.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL", ACCRUED);
    await pay(repo, "5000.00");
    expect(db.productWasRead).toBe(false);
  });
});
