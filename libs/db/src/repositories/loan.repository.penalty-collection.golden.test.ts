import { ACCOUNT_CODES, DEFAULT_CHART_OF_ACCOUNTS } from "@loan/accounting";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * GOLDEN TESTS — what happens to an accrued late fee when the borrower pays.
 *
 * Written against the CURRENT implementation and committed passing BEFORE it
 * is touched, per §81. The answer today is "nothing happens to it", and that
 * is the defect this file exists to state as evidence rather than as a
 * remark: a late fee accrues to the receivable, is recognised as income, and
 * then there is no path by which a borrower can hand over money that settles
 * it.
 *
 * The two files next door each pin half of the picture and neither pins this
 * one:
 *
 *   - `loan.repository.penalties.golden.test.ts` pins what `accruedPenaltiesFor`
 *     REPORTS. It never records a payment.
 *   - `loan.repository.allocation-order.test.ts` pins that the three §26
 *     orders agree. It seeds no accruals at all, so it demonstrates the
 *     agreement on a book with no penalties rather than on one with them.
 *
 * What is missing between them is the case that matters: a loan carrying a
 * REAL `LATE_FEE_ACCRUAL` balance in the ledger, driven through
 * `recordPayment`. That is what is pinned here.
 *
 * ── What the current implementation does, exactly ───────────────────────
 *
 * `recordPayment` reads the loan's open instalments and calls
 * `allocatePayment` with four fields per row — `interestDue`,
 * `principalDue`, `interestPaid`, `principalPaid` — and nothing else.
 * `feeDue` and `penaltyDue` are not passed and there is nowhere on
 * `LoanSchedule` they could be read from. `openByTier` therefore resolves
 * both to `max(0, 0 - 0) = 0`, every order's FEES and PENALTIES tiers take
 * `min(remaining, 0) = 0`, and `allocation.penalties` comes back
 * `undefined`. `loanPaymentEntry` receives `penaltyPortion: 0` and omits the
 * line.
 *
 * The accrual in the ledger is not consulted on the payment path at all. It
 * is read only by `accruedPenaltiesFor`, which is a display figure, and by
 * the nightly accrual, which uses it to compute the delta to post.
 *
 * Three consequences, each pinned below:
 *
 *   1. All three allocation orders produce identical figures on a loan that
 *      HAS an accrued penalty, not merely on one that has none. The tiers
 *      are inert because their inputs are absent, not because the book is
 *      clean.
 *   2. An instalment is stamped `paidInFullAt` once its interest and
 *      principal are covered, while its penalty is still outstanding — and
 *      it then drops out of the `paidInFullAt: null` set `recordPayment`
 *      reads, so no later payment can reach it either. The fee is not
 *      merely uncollected; after that moment it is uncollectABLE.
 *   3. A borrower who pays the entire schedule to the last centavo still
 *      owes every peso of penalty, and `accruedPenaltiesFor` still reports
 *      it as outstanding.
 *
 * ── The control, and the safety property ────────────────────────────────
 *
 * The last describe block runs the same payments against a loan with NO
 * accrual anywhere in the ledger. Those figures are the safety property:
 * they are what must not move by a centavo when penalties become
 * collectable. Every loan on the books today is in exactly that position on
 * the legacy order, so "existing borrowers are unaffected" is checkable here
 * rather than merely asserted.
 *
 * ── Reading a number in this file ───────────────────────────────────────
 *
 * A figure moving here is a borrower's money moving. The penalty-bearing
 * expectations are EXPECTED to move when the feature lands — that is the
 * point of the feature — and each one that moves must be changed with a
 * written reason. The control block's figures are not expected to move and
 * a change to one of them is a regression, not an update.
 */

// ─── Fixture ────────────────────────────────────────────────────────────

/**
 * The golden schedule used by every allocation test in the workspace:
 * ₱50,000.00 over 6 monthly instalments at 18% p.a., first three rows.
 */
const ROWS = [
  { principalDue: "8026.26", interestDue: "750.00" },
  { principalDue: "8146.65", interestDue: "629.61" },
  { principalDue: "8268.85", interestDue: "507.41" },
];

/** Instalment 1's `totalDue`, the amount that settles it exactly. */
const INSTALMENT_1 = "8776.26";

/**
 * Accrued late fees, per instalment, as `LATE_FEE_ACCRUAL` journal entries.
 *
 * Two postings on instalment 1 because the nightly job posts a delta each
 * day rather than one entry per instalment — the read has to sum them, and a
 * fixture with a single posting per row would not exercise that.
 *
 * Under the default policy (1%/day, capped at 10%) instalment 1's cap is
 * 877.63, so 250.00 is a realistic mid-accrual figure rather than a round
 * number chosen for arithmetic convenience.
 *
 *   s-1: 100.00 + 150.00 = 250.00
 *   s-2:            60.00 =  60.00
 *   s-3:                  =   0.00
 *                   total   310.00
 */
const ACCRUALS: Array<{ scheduleId: string; day: string; amount: string }> = [
  { scheduleId: "s-1", day: "2026-04-08", amount: "100.00" },
  { scheduleId: "s-1", day: "2026-04-09", amount: "150.00" },
  { scheduleId: "s-2", day: "2026-05-09", amount: "60.00" },
];

const TOTAL_ACCRUED = 310.0;

const LOAN_ID = "9c4e7a15-2b83-4f60-91d7-6e0a3c85b2f4";
const OFFICER = "user-penalty-1";
const PAID_ON = new Date(Date.UTC(2026, 3, 5));

const ORDERS = [
  "INTEREST_PRINCIPAL",
  "FEES_PENALTIES_INTEREST_PRINCIPAL",
  "INTEREST_PRINCIPAL_FEES_PENALTIES",
] as const;

type Order = (typeof ORDERS)[number];

function money(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return new Prisma.Decimal(v as Prisma.Decimal.Value).toFixed(2);
}

// ─── Test double ────────────────────────────────────────────────────────

interface Line {
  id?: string;
  accountId: string;
  debit: number | string;
  credit: number | string;
  memo?: string;
}

interface Entry {
  id: string;
  number: string;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  lines: Line[];
}

/**
 * Enough of Prisma for `recordPayment`, `accruedPenaltiesFor` and
 * `waivePenalty` to run against an in-memory book.
 *
 * Deliberately a purpose-built double rather than `inMemoryLedger`: that one
 * models the ledger for read paths and has no `loanSchedule.update` or
 * `loanPayment.create`, which is exactly the half this file needs.
 */
class Db {
  loans: Array<Record<string, unknown>> = [];
  schedules: Array<Record<string, unknown>> = [];
  entries: Entry[] = [];
  waivers: Array<Record<string, unknown>> = [];
  accounts = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
    id: `acct-${a.code}`,
    code: a.code,
    active: true,
  }));
  periods: Array<{ id: string; year: number; month: number }> = [];
  seq = 0;

  next(p: string): string {
    this.seq += 1;
    return `${p}-${this.seq}`;
  }

  accountId(code: string): string {
    return `acct-${code}`;
  }

  inst(no: number): Record<string, unknown> {
    return this.schedules.find((s) => s.installmentNo === no)!;
  }

  /** Total credited to `code` across every entry posted so far. */
  credited(code: string): string {
    const id = this.accountId(code);
    return money(
      this.entries
        .flatMap((e) => e.lines)
        .filter((l) => l.accountId === id)
        .reduce((s, l) => s + Number(l.credit), 0),
    );
  }

  memos(): string[] {
    return this.entries.flatMap((e) => e.lines.map((l) => l.memo ?? ""));
  }

  /** Every line memo that starts with `prefix`, with its credit amount. */
  linesMemoed(prefix: string): Array<{ memo: string; credit: string }> {
    return this.entries
      .flatMap((e) => e.lines)
      .filter((l) => (l.memo ?? "").startsWith(prefix))
      .map((l) => ({ memo: l.memo!, credit: money(l.credit) }));
  }
}

function makeClient(db: Db): PrismaClient {
  const scheduleOf = (loanId: string) =>
    db.schedules
      .filter((s) => s.loanId === loanId)
      .sort(
        (a, b) => (a.installmentNo as number) - (b.installmentNo as number),
      );

  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),

    loanApplication: {
      findFirst: async ({
        where,
        include,
      }: {
        where: { id?: string; number?: string };
        include?: { schedule?: unknown };
      }) => {
        const l = db.loans.find(
          (x) =>
            (where.id !== undefined && x.id === where.id) ||
            (where.number !== undefined && x.number === where.number),
        );
        if (!l) return null;
        return include?.schedule
          ? { ...l, schedule: scheduleOf(l.id as string) }
          : l;
      },
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
      findMany: async ({
        where,
      }: {
        where: { loanId: string; paidInFullAt?: null };
      }) =>
        scheduleOf(where.loanId).filter(
          (s) => !("paidInFullAt" in where) || s.paidInFullAt === null,
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
        scheduleOf(where.loanId).filter(
          (s) => !("paidInFullAt" in where) || s.paidInFullAt === null,
        ).length,
    },

    penaltyWaiver: {
      findMany: async ({ where }: { where: { loanId: string } }) =>
        db.waivers.filter((w) => w.loanId === where.loanId),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const w = { id: db.next("waiver"), ...data };
        db.waivers.push(w);
        return w;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const w = db.waivers.find((x) => x.id === where.id)!;
        Object.assign(w, data);
        return w;
      },
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
      /** `postIfAbsent` → `findBySourceRef`. */
      findFirst: async ({
        where,
      }: {
        where: {
          source?: string;
          sourceRefType?: string | null;
          sourceRefId?: string | null;
        };
      }) =>
        db.entries.find(
          (e) =>
            e.source === where.source &&
            e.sourceRefType === (where.sourceRefType ?? null) &&
            e.sourceRefId === (where.sourceRefId ?? null),
        ) ?? null,

      /**
       * The accrual lookup: `source` + `sourceRefType` + an `OR` of
       * `sourceRefId startsWith` clauses, with lines and their accounts.
       */
      findMany: async ({
        where,
      }: {
        where: {
          source?: string;
          sourceRefType?: string;
          OR?: Array<{ sourceRefId: { startsWith: string } }>;
        };
      }) =>
        db.entries
          .filter(
            (e) =>
              (where.source === undefined || e.source === where.source) &&
              (where.sourceRefType === undefined ||
                e.sourceRefType === where.sourceRefType) &&
              (where.OR === undefined ||
                where.OR.some((o) =>
                  (e.sourceRefId ?? "").startsWith(o.sourceRefId.startsWith),
                )),
          )
          .map((e) => ({
            ...e,
            lines: e.lines.map((l) => ({
              ...l,
              credit: new Prisma.Decimal(l.credit),
              account: {
                code:
                  db.accounts.find((a) => a.id === l.accountId)?.code ?? "????",
              },
            })),
          })),

      create: async ({
        data,
      }: {
        data: Record<string, unknown> & { lines: { create: Line[] } };
      }) => {
        const e: Entry = {
          id: db.next("je"),
          number: `JE-${db.seq}`,
          source: data.source as string,
          sourceRefType: (data.sourceRefType as string) ?? null,
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

/**
 * An ACTIVE loan on `order`, with `accruals` posted against its schedule.
 * Pass `accruals: []` for the control case.
 */
function seed(
  order: Order,
  accruals: typeof ACCRUALS = ACCRUALS,
): { db: Db; repo: LoanRepository } {
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
  for (const a of accruals) {
    db.entries.push({
      id: db.next("accr"),
      number: `JE-ACCR-${db.seq}`,
      source: "LATE_FEE_ACCRUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: `${a.scheduleId}:${a.day}`,
      lines: [
        {
          accountId: db.accountId(ACCOUNT_CODES.LOANS_RECEIVABLE),
          debit: a.amount,
          credit: "0.00",
        },
        {
          accountId: db.accountId(ACCOUNT_CODES.FEE_INCOME),
          debit: "0.00",
          credit: a.amount,
        },
      ],
    });
  }
  return { db, repo: new LoanRepository(makeClient(db)) };
}

function pay(repo: LoanRepository, amount: string) {
  return repo.recordPayment(LOAN_ID, {
    amount: new Prisma.Decimal(amount) as unknown as number,
    paidOn: PAID_ON,
    recordedById: OFFICER,
  });
}

/** Everything a borrower could dispute about one payment, in one object. */
function outcome(db: Db) {
  return {
    interestIncome: db.credited(ACCOUNT_CODES.INTEREST_INCOME),
    receivable: db.credited(ACCOUNT_CODES.LOANS_RECEIVABLE),
    advances: db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES),
    feeIncome: db.credited(ACCOUNT_CODES.FEE_INCOME),
    progress: [1, 2, 3].map((n) => [
      money(db.inst(n).interestPaid),
      money(db.inst(n).principalPaid),
      db.inst(n).paidInFullAt === null ? "open" : "settled",
    ]),
  };
}

// ─── The book the fixture describes ─────────────────────────────────────

describe("GOLDEN — the accrued penalty this fixture starts from", () => {
  it("is 310.00 across the loan, and is real ledger, not a column", async () => {
    // Stated here so that every expectation below can be read against a
    // known starting balance. It comes from `LATE_FEE_ACCRUAL` entries; no
    // column on `LoanSchedule` records any part of it.
    const { repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 0,
      outstanding: TOTAL_ACCRUED,
    });
  });

  it("sits on instalments 1 and 2 and nowhere else", async () => {
    // 250.00 on #1, 60.00 on #2, nothing on #3. The per-instalment split is
    // recoverable from the ledger keys — `"<scheduleId>:<periodKey>"` — and
    // is precisely the figure no consumer currently derives.
    const { db } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    const byId = new Map<string, number>();
    for (const e of db.entries) {
      if (e.source !== "LATE_FEE_ACCRUAL") continue;
      const sid = e.sourceRefId!.slice(0, e.sourceRefId!.indexOf(":"));
      const fee = e.lines.find(
        (l) => l.accountId === db.accountId(ACCOUNT_CODES.FEE_INCOME),
      );
      byId.set(sid, (byId.get(sid) ?? 0) + Number(fee!.credit));
    }
    expect([...byId.entries()].sort()).toEqual([
      ["s-1", 250.0],
      ["s-2", 60.0],
    ]);
  });
});

// ─── 1. The orders agree even when the penalty is real ──────────────────

describe("GOLDEN — all three orders allocate identically, penalty or no penalty", () => {
  /*
   * The claim `loan.repository.allocation-order.test.ts` makes is that the
   * §26 tiers are inert. It demonstrates that on a loan with no accruals,
   * which leaves open the reading "they are inert because this book happens
   * to be clean". They are not. They are inert because `recordPayment`
   * never passes the balances, so a book with 310.00 of accrued penalty
   * allocates exactly as one with none.
   *
   * This is the test whose figures the feature is meant to change.
   */
  const AMOUNTS = ["5000.00", INSTALMENT_1, "12000.00", "30000.00"];

  it("produces identical figures on all three orders", async () => {
    for (const amount of AMOUNTS) {
      const results: Array<ReturnType<typeof outcome>> = [];
      for (const order of ORDERS) {
        const { db, repo } = seed(order);
        await pay(repo, amount);
        results.push(outcome(db));
      }
      for (const r of results) expect(r).toEqual(results[0]);
    }
  });

  it("posts no Penalties line on any order", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "12000.00");
      expect(db.memos().some((m) => m.startsWith("Penalties on"))).toBe(false);
      expect(db.memos().some((m) => m.startsWith("Fees on"))).toBe(false);
    }
  });

  it("splits ₱5,000 as 750.00 interest / 4,250.00 principal on every order", async () => {
    // The figure itself, so that a change to it is visible as a number and
    // not only as an equality between three runs.
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "5000.00");
      expect(outcome(db)).toEqual({
        interestIncome: "750.00",
        receivable: "4250.00",
        advances: "0.00",
        // The 310.00 already credited by the accrual entries, untouched.
        feeIncome: "310.00",
        progress: [
          ["750.00", "4250.00", "open"],
          ["0.00", "0.00", "open"],
          ["0.00", "0.00", "open"],
        ],
      });
    }
  });
});

// ─── 2. Settling an instalment strands its penalty ──────────────────────

describe("GOLDEN — an instalment closes with its penalty outstanding", () => {
  it("stamps paidInFullAt on interest + principal alone", async () => {
    // 8,776.26 is instalment 1's totalDue exactly. 250.00 of penalty is
    // accrued against it and is not consulted.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, INSTALMENT_1);

    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("8026.26");
    expect(db.inst(1).paidInFullAt).toEqual(PAID_ON);
  });

  it("then removes that instalment from the set any later payment can reach", async () => {
    /*
     * The reason this is worse than "uncollected". `recordPayment` reads
     * `{ loanId, paidInFullAt: null }`. Once #1 is stamped, its 250.00 is
     * behind a filter no payment path ever lifts, so the fee cannot be
     * collected by any subsequent payment either — however large, however
     * the order is configured.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, INSTALMENT_1);

    const reachable = db.schedules
      .filter((s) => s.paidInFullAt === null)
      .map((s) => s.id);
    expect(reachable).toEqual(["s-2", "s-3"]);

    // A second, generous payment confirms it: nothing lands on s-1.
    await pay(repo, "50000.00");
    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("8026.26");
    expect(db.memos().some((m) => m.startsWith("Penalties on"))).toBe(false);
  });
});

// ─── 3. Paying the whole schedule leaves the whole penalty owing ────────

describe("GOLDEN — the borrower cannot pay the late fee at all", () => {
  it("still owes 310.00 after paying every instalment in full", async () => {
    // The headline. Total schedule = 8,776.26 × 3 = 26,328.78.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26328.78");

    expect(db.schedules.every((s) => s.paidInFullAt !== null)).toBe(true);
    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 0,
      outstanding: TOTAL_ACCRUED,
    });
  });

  it("books the excess to Customer Advances rather than to the penalty", async () => {
    /*
     * Handing over MORE than the schedule does not settle the fee either.
     * The 310.00 surplus becomes a liability to the borrower while the
     * borrower simultaneously owes 310.00 of penalty — the same peso on
     * both sides of the balance sheet, which is the clearest possible
     * statement that the two are not connected.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26638.78");

    expect(db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe("310.00");
    expect((await repo.accruedPenaltiesFor(LOAN_ID)).outstanding).toBe(
      TOTAL_ACCRUED,
    );
  });

  it("closes the loan with the penalty still on the books", async () => {
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26328.78");
    expect(db.loans[0]!.status).toBe("CLOSED");
    expect((await repo.accruedPenaltiesFor(LOAN_ID)).outstanding).toBe(
      TOTAL_ACCRUED,
    );
  });
});

// ─── 4. A waiver leaves no per-instalment trace ─────────────────────────

describe("GOLDEN — waiving is loan-level and unattributed", () => {
  it("reduces the loan-level figure and touches no instalment", async () => {
    /*
     * `PenaltyWaiver` carries a `loanId` and an amount. Nothing anywhere
     * records WHICH instalment's penalty was forgiven, so the loan-level
     * total and the per-instalment accruals cannot be reconciled against
     * each other — there is no per-instalment figure to reconcile.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    const before = db.schedules.map((s) => ({ ...s }));

    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "Goodwill — first arrears",
      waivedById: OFFICER,
    });

    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 100,
      outstanding: 210,
    });
    // Not one schedule row differs.
    expect(db.schedules).toEqual(before);
  });

  it("posts the reversal against the loan, not against an instalment", async () => {
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    const { journalEntryId } = await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "Goodwill",
      waivedById: OFFICER,
    });
    const entry = db.entries.find((e) => e.id === journalEntryId)!;
    expect(entry.source).toBe("PENALTY_WAIVE");
    expect(entry.sourceRefType).toBe("PenaltyWaiver");
    // The ref is the waiver id. No schedule id appears anywhere on it.
    expect(entry.sourceRefId).not.toMatch(/^s-\d/);
  });

  it("lets a waiver be granted for a penalty the borrower has already settled — vacuously, today", async () => {
    /*
     * `waivePenalty` validates against `accrued - alreadyWaived`. It does
     * not subtract anything collected, because nothing can be collected.
     * The moment penalties become payable this becomes a live double-relief
     * hole, so the current arithmetic is pinned here to make the change to
     * it deliberate.
     */
    const { repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26328.78"); // pays the entire schedule
    // The full 310.00 is still waivable afterwards.
    await expect(
      repo.waivePenalty(LOAN_ID, {
        waivedAmount: TOTAL_ACCRUED,
        reason: "Full waive after settlement",
        waivedById: OFFICER,
      }),
    ).resolves.toMatchObject({
      waiver: { originalPenalty: TOTAL_ACCRUED, negotiatedPenalty: 0 },
    });
  });
});

// ─── 5. The control: no accrual anywhere ────────────────────────────────

describe("GOLDEN — a loan with no accrued penalty (the safety property)", () => {
  /*
   * THESE FIGURES MUST NOT MOVE.
   *
   * Every loan written before penalties become collectable is on
   * `INTEREST_PRINCIPAL` (§26 backfilled it, and it is what they were
   * already doing), and the overwhelming majority have never been late. If
   * a single number in this block changes, a borrower who did nothing wrong
   * is paying something different, and that is a regression rather than the
   * feature.
   *
   * Kept deliberately as literal amounts rather than as a comparison
   * between orders: an equality between three wrong answers still passes.
   */
  const NONE: typeof ACCRUALS = [];

  it("splits ₱5,000 identically on all three orders", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order, NONE);
      await pay(repo, "5000.00");
      expect(outcome(db)).toEqual({
        interestIncome: "750.00",
        receivable: "4250.00",
        advances: "0.00",
        feeIncome: "0.00",
        progress: [
          ["750.00", "4250.00", "open"],
          ["0.00", "0.00", "open"],
          ["0.00", "0.00", "open"],
        ],
      });
    }
  });

  it("settles instalment 1 exactly on its totalDue, on all three orders", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order, NONE);
      await pay(repo, INSTALMENT_1);
      expect(outcome(db)).toEqual({
        interestIncome: "750.00",
        receivable: "8026.26",
        advances: "0.00",
        feeIncome: "0.00",
        progress: [
          ["750.00", "8026.26", "settled"],
          ["0.00", "0.00", "open"],
          ["0.00", "0.00", "open"],
        ],
      });
    }
  });

  it("leaves instalment 1 open one centavo short, on all three orders", async () => {
    // The boundary the centavo comparison in `isAtLeast` exists for.
    for (const order of ORDERS) {
      const { db, repo } = seed(order, NONE);
      await pay(repo, "8776.25");
      expect(db.inst(1).paidInFullAt).toBeNull();
      expect(money(db.inst(1).principalPaid)).toBe("8026.25");
    }
  });

  it("spans instalments and books the surplus to advances, on all three orders", async () => {
    // 30,000 against a 26,328.78 schedule: everything settled, 3,671.22 over.
    for (const order of ORDERS) {
      const { db, repo } = seed(order, NONE);
      await pay(repo, "30000.00");
      expect(outcome(db)).toEqual({
        interestIncome: "1887.02",
        receivable: "24441.76",
        advances: "3671.22",
        feeIncome: "0.00",
        progress: [
          ["750.00", "8026.26", "settled"],
          ["629.61", "8146.65", "settled"],
          ["507.41", "8268.85", "settled"],
        ],
      });
      expect(db.loans[0]!.status).toBe("CLOSED");
    }
  });

  it("posts no fee or penalty line, and every entry balances", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order, NONE);
      await pay(repo, "12000.00");
      expect(db.linesMemoed("Penalties on")).toEqual([]);
      expect(db.linesMemoed("Fees on")).toEqual([]);
      for (const e of db.entries) {
        const d = e.lines.reduce((s, l) => s + Number(l.debit), 0);
        const c = e.lines.reduce((s, l) => s + Number(l.credit), 0);
        expect(money(d)).toBe(money(c));
      }
    }
  });

  it("reports no penalty at all", async () => {
    const { repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL", NONE);
    await pay(repo, "26328.78");
    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: 0,
      waivedToDate: 0,
      outstanding: 0,
    });
  });
});
