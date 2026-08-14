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
 * ── Why order-sensitivity is not observable end to end yet ──────────────
 *
 * `recordPayment` passes no fee or penalty due, because no per-instalment
 * fee or penalty balance is modelled anywhere in this system (see the note
 * on `allocatePayment`). With both tiers at zero, all three orders allocate
 * identically — which is exactly what the first test here asserts, and is
 * the property that makes it safe to offer §26's order on a new product
 * today: selecting it cannot move a peso until those balances are real.
 *
 * When they become real this file needs a companion test driving a loan
 * with a genuine penalty balance through both orders and pinning the
 * difference. It cannot be written honestly before then.
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
  accounts = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
    id: `acct-${a.code}`,
    code: a.code,
    active: true,
  }));
  periods: Array<{ id: string; year: number; month: number }> = [];
  /** Set if anything reads LoanProduct during a payment. */
  productWasRead = false;
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
function seed(order: (typeof ORDERS)[number]): {
  db: Db;
  repo: LoanRepository;
} {
  const db = new Db();
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

describe("the new tiers are inert until fee and penalty balances exist", () => {
  /*
   * End-to-end statement of the property that makes §26's order safe to
   * offer today. `recordPayment` supplies no fee or penalty due — there is
   * no per-instalment balance to supply — so all three orders land on the
   * same figures. Selecting §26's order on a new product cannot move a
   * peso until those balances are modelled.
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
