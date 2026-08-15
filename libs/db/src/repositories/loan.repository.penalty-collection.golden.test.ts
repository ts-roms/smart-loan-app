import { ACCOUNT_CODES, DEFAULT_CHART_OF_ACCOUNTS } from "@loan/accounting";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * GOLDEN TESTS — what happens to an accrued late fee when the borrower pays.
 *
 * First committed against the pre-change implementation, per §81, where it
 * documented the defect: a late fee accrued to the receivable, was
 * recognised as income, and there was no path by which a borrower could
 * hand over money that settled it. Those figures have now moved, which is
 * the feature. Every one that moved is named below with what it was.
 *
 * The two files next door each pin half of the picture and neither pins
 * this one:
 *
 *   - `loan.repository.penalties.golden.test.ts` pins what
 *     `accruedPenaltiesFor` REPORTS. It never records a payment.
 *   - `loan.repository.allocation-order.test.ts` pins the snapshot rule and
 *     the orders at the repository. It seeds no accruals.
 *
 * What is between them is the case that matters: a loan carrying a REAL
 * `LATE_FEE_ACCRUAL` balance in the ledger, driven through `recordPayment`.
 *
 * ── What the implementation now does ────────────────────────────────────
 *
 * For a loan whose order carries the PENALTIES tier, `recordPayment` reads
 * the `LATE_FEE_ACCRUAL` entries for its OPEN instalments and passes, per
 * row, `penaltyDue = accrued - penaltyWaived` and
 * `penaltyPaid = LoanSchedule.penaltyPaid`. The allocator's PENALTIES tier
 * then takes `min(remaining, accrued - waived - paid)` in its position in
 * the order, the slice is persisted to `penaltyPaid`, and
 * `loanPaymentEntry` posts it as a Loans Receivable credit memoed
 * "Penalties on …" — not a Fee Income credit, because the income was
 * recognised when the fee accrued.
 *
 * For a loan on `INTEREST_PRINCIPAL` the accrual ledger is not read at all
 * and nothing about the payment changes.
 *
 * ── The figures that moved, and what they were ──────────────────────────
 *
 *   ₱5,000 on FEES_PENALTIES_INTEREST_PRINCIPAL: principal was 4,250.00,
 *   is now 4,000.00, with 250.00 to penalty. That 250.00 is the borrower's
 *   money going somewhere different and is the entire point of §26. The
 *   legacy order and `INTEREST_PRINCIPAL_FEES_PENALTIES` are unchanged on
 *   this amount — the latter because ₱5,000 never gets past principal.
 *
 *   ₱8,776.26 (instalment 1 exactly) on INTEREST_PRINCIPAL_FEES_PENALTIES:
 *   the row WAS stamped `paidInFullAt` with 250.00 of penalty outstanding,
 *   which dropped it out of the `paidInFullAt: null` set every future
 *   payment reads and made the fee uncollectable. It now stays open. This
 *   is the defect the batch exists to close, and it is why settlement asks
 *   about every tier the order collects rather than only two.
 *
 *   ₱26,328.78 (the whole schedule) on either penalty-collecting order:
 *   the loan WAS closed with 310.00 of penalty still owing. The same money
 *   now settles the 310.00 and leaves 310.00 of principal, so the loan
 *   stays open — the borrower owes the same total either way, but the
 *   ledger and the schedule now agree about what it is.
 *
 *   ₱26,638.78 (schedule + 310.00) on either penalty-collecting order: the
 *   surplus WAS booked to Customer Advances while the borrower
 *   simultaneously owed 310.00 of penalty — the same peso on both sides of
 *   the balance sheet. It now clears the loan outright.
 *
 *   Waiving after full settlement: `waivePenalty` accepted a waiver of the
 *   full 310.00 against a penalty the borrower had already paid. It now
 *   refuses, because the outstanding figure is net of collections. That
 *   was pinned before the change precisely so this would have to be a
 *   deliberate decision rather than an oversight.
 *
 * ── The control, and the safety property ────────────────────────────────
 *
 * The last describe block runs the same payments against a loan with NO
 * accrual anywhere in the ledger. NOT ONE OF ITS FIGURES MOVED. Every loan
 * on the books is on the legacy order and the overwhelming majority have
 * never been late, so that block is the evidence for "existing borrowers
 * are unaffected" rather than the claim.
 *
 * ── Reading a number in this file ───────────────────────────────────────
 *
 * A figure moving here is a borrower's money moving. Change one only with
 * a written reason, and only after confirming the change was meant to
 * reach borrowers at all.
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
  /** How many times the LATE_FEE_ACCRUAL prefix lookup has been issued. */
  accrualLookups = 0;
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
      }) => {
        if (where.source === "LATE_FEE_ACCRUAL") db.accrualLookups += 1;
        return db.entries
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
          }));
      },

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
      penaltyPaid: new Prisma.Decimal(0),
      penaltyWaived: new Prisma.Decimal(0),
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

/**
 * Everything a borrower could dispute about one payment, in one object.
 *
 * `receivable` is the TOTAL credited to Loans Receivable, and it is
 * deliberately not enough on its own: a penalty credit and a principal
 * credit land on the same account, separated only by their memo, so an
 * order that collects 250.00 of penalty and 4,000.00 of principal is
 * indistinguishable here from one that collects 4,250.00 of principal. The
 * per-instalment `progress` rows are what tell them apart, which is exactly
 * why `LoanSchedule.penaltyPaid` has to exist.
 */
function outcome(db: Db) {
  return {
    interestIncome: db.credited(ACCOUNT_CODES.INTEREST_INCOME),
    receivable: db.credited(ACCOUNT_CODES.LOANS_RECEIVABLE),
    advances: db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES),
    feeIncome: db.credited(ACCOUNT_CODES.FEE_INCOME),
    progress: [1, 2, 3].map((n) => [
      money(db.inst(n).interestPaid),
      money(db.inst(n).principalPaid),
      money(db.inst(n).penaltyPaid),
      db.inst(n).paidInFullAt === null ? "open" : "settled",
    ]),
  };
}

// ─── The book the fixture describes ─────────────────────────────────────

describe("GOLDEN — the accrued penalty this fixture starts from", () => {
  it("is 310.00 across the loan, and is still real ledger, not a column", async () => {
    /*
     * Stated here so every expectation below can be read against a known
     * starting balance — and to pin the design decision. The accrued figure
     * comes from `LATE_FEE_ACCRUAL` entries and STILL does. No column on
     * `LoanSchedule` records it. The two columns this batch added hold only
     * the halves the ledger cannot answer: which instalment a collection
     * settled, and which one a waiver relieved.
     *
     * `paidToDate` is new on this response. It is zero here because nothing
     * has been paid yet.
     */
    const { repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 0,
      paidToDate: 0,
      outstanding: TOTAL_ACCRUED,
    });
  });

  it("sits on instalments 1 and 2 and nowhere else", async () => {
    // 250.00 on #1, 60.00 on #2, nothing on #3. The per-instalment split is
    // recoverable from the ledger keys — `"<scheduleId>:<periodKey>"` — and
    // is the figure the allocator now consumes.
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

// ─── 1. The orders now diverge, because the balance is real ─────────────

describe("GOLDEN — a real penalty makes the three orders disagree", () => {
  /*
   * The replacement for what this block used to assert. It previously
   * pinned that all three orders produced IDENTICAL figures on a loan
   * carrying 310.00 of accrued penalty — the tiers were inert because
   * `recordPayment` never passed the balances, not because the book was
   * clean. That is no longer true and must no longer be asserted.
   *
   * What replaces it is the same question asked properly: given a real
   * penalty balance, what does each order actually do with the borrower's
   * money? The answer is stated as literal amounts rather than as an
   * inequality, because "they differ" is not a fact anyone can check a
   * statement against.
   */

  it("₱5,000 — §26's order takes the penalty first and kills 250.00 less principal", async () => {
    /*
     * WAS: 750.00 interest / 4,250.00 principal, penalty untouched.
     * NOW: 250.00 penalty / 750.00 interest / 4,000.00 principal.
     *
     * The 250.00 is the borrower's money going somewhere different, and it
     * is precisely the change §26 asked for. Note `receivable` is 4,250.00
     * either way: the penalty credit and the principal credit hit the same
     * account. Only `progress` distinguishes them, which is why the column
     * had to exist.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "5000.00");
    expect(outcome(db)).toEqual({
      interestIncome: "750.00",
      receivable: "4250.00",
      advances: "0.00",
      // Unmoved: the income was recognised when the fee accrued. Collecting
      // it is the asset converting to cash, not a second recognition.
      feeIncome: "310.00",
      progress: [
        ["750.00", "4000.00", "250.00", "open"],
        ["0.00", "0.00", "0.00", "open"],
        ["0.00", "0.00", "0.00", "open"],
      ],
    });
  });

  it("₱5,000 — the legacy order is untouched, to the centavo", async () => {
    // The safety property at the amount where §26's order visibly differs.
    const { db, repo } = seed("INTEREST_PRINCIPAL");
    await pay(repo, "5000.00");
    expect(outcome(db)).toEqual({
      interestIncome: "750.00",
      receivable: "4250.00",
      advances: "0.00",
      feeIncome: "310.00",
      progress: [
        ["750.00", "4250.00", "0.00", "open"],
        ["0.00", "0.00", "0.00", "open"],
        ["0.00", "0.00", "0.00", "open"],
      ],
    });
  });

  it("₱5,000 — the borrower-friendly order never reaches the penalty", async () => {
    // Charges last, and ₱5,000 does not get past instalment 1's principal.
    // Identical to the legacy order here, and that is a real property of
    // the order rather than a leftover of the tiers being inert.
    const { db, repo } = seed("INTEREST_PRINCIPAL_FEES_PENALTIES");
    await pay(repo, "5000.00");
    expect(outcome(db).progress).toEqual([
      ["750.00", "4250.00", "0.00", "open"],
      ["0.00", "0.00", "0.00", "open"],
      ["0.00", "0.00", "0.00", "open"],
    ]);
  });

  it("posts a Penalties line crediting Loans Receivable, never Fee Income", async () => {
    /*
     * The accounting §26 built and this batch finally exercises. A late fee
     * is income the moment it accrues (`lateFeeAccrualEntry` posts
     * Dr Loans Receivable / Cr Fee Income), so collecting it is
     * Dr Cash / Cr Loans Receivable. Crediting Fee Income again here would
     * book the same peso of income twice.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "5000.00");

    expect(db.linesMemoed("Penalties on")).toEqual([
      { memo: "Penalties on LN-2026-000077", credit: "250.00" },
    ]);
    const penaltyLine = db.entries
      .flatMap((e) => e.lines)
      .find((l) => (l.memo ?? "").startsWith("Penalties on"))!;
    expect(penaltyLine.accountId).toBe(
      db.accountId(ACCOUNT_CODES.LOANS_RECEIVABLE),
    );
    // Fee Income is exactly the 310.00 the accruals credited. Not a centavo
    // more.
    expect(db.credited(ACCOUNT_CODES.FEE_INCOME)).toBe("310.00");
  });

  it("still posts no Fees line, on any order", async () => {
    // The FEES tier stays inert and correctly so: no fee in this system is
    // ever owed as a balance.
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "12000.00");
      expect(db.linesMemoed("Fees on")).toEqual([]);
    }
  });

  it("every entry still balances, on every order", async () => {
    for (const order of ORDERS) {
      const { db, repo } = seed(order);
      await pay(repo, "12000.00");
      for (const e of db.entries) {
        const d = e.lines.reduce((s, l) => s + Number(l.debit), 0);
        const c = e.lines.reduce((s, l) => s + Number(l.credit), 0);
        expect(money(d)).toBe(money(c));
      }
    }
  });
});

// ─── 2. An instalment is no longer stamped over its own penalty ─────────

describe("GOLDEN — settlement asks about every tier the order collects", () => {
  it("holds the row open when the penalty is taken last and the money runs out", async () => {
    /*
     * ₱8,776.26 is instalment 1's totalDue exactly, and 250.00 of penalty
     * is accrued against it.
     *
     * WAS: interest and principal covered, `paidInFullAt` stamped, 250.00
     * stranded — and stranded permanently, because `recordPayment` reads
     * `paidInFullAt: null` and the row had just left that set.
     *
     * NOW: the row stays open. That is the defect this batch closes, and
     * `INTEREST_PRINCIPAL_FEES_PENALTIES` is where it bit hardest, because
     * the penalty is the last tier and is the one the money runs out on.
     */
    const { db, repo } = seed("INTEREST_PRINCIPAL_FEES_PENALTIES");
    await pay(repo, INSTALMENT_1);

    expect(money(db.inst(1).interestPaid)).toBe("750.00");
    expect(money(db.inst(1).principalPaid)).toBe("8026.26");
    expect(money(db.inst(1).penaltyPaid)).toBe("0.00");
    expect(db.inst(1).paidInFullAt).toBeNull();
  });

  it("so a later payment can still reach it", async () => {
    // The consequence, and the whole point. A second payment settles the
    // penalty that used to be unreachable.
    const { db, repo } = seed("INTEREST_PRINCIPAL_FEES_PENALTIES");
    await pay(repo, INSTALMENT_1);
    await pay(repo, "250.00");

    expect(money(db.inst(1).penaltyPaid)).toBe("250.00");
    expect(db.inst(1).paidInFullAt).toEqual(PAID_ON);
    expect(db.linesMemoed("Penalties on")).toEqual([
      { memo: "Penalties on LN-2026-000077", credit: "250.00" },
    ]);
  });

  it("does not re-collect the penalty on the next payment", async () => {
    /*
     * The reason `penaltyPaid` had to be a persisted column rather than a
     * figure derived at payment time. Allocation runs against
     * `accrued - waived - paid`; without the paid term a borrower settling
     * one penalty across several payments would be charged it each time —
     * the exact defect `repair-payment-allocations.ts` exists to clean up
     * after.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "100.00");
    await pay(repo, "100.00");
    await pay(repo, "100.00");

    expect(money(db.inst(1).penaltyPaid)).toBe("250.00");
    // 250.00 of penalty then 50.00 of interest — not 300.00 of penalty.
    expect(money(db.inst(1).interestPaid)).toBe("50.00");
    expect(
      db.linesMemoed("Penalties on").reduce((s, l) => s + Number(l.credit), 0),
    ).toBe(250.0);
  });

  it("still stamps a legacy-order row on interest and principal alone", async () => {
    /*
     * THE SAFETY PROPERTY, at its sharpest. This loan HAS an accrued
     * penalty and its order has no tier that can ever collect it. Requiring
     * the penalty for settlement would leave the row open forever: the loan
     * would never close, and `lateFeeFor` charges any row whose
     * `paidInFullAt` is null, so it would go on accruing late fees to the
     * policy cap against a debt already repaid in full.
     *
     * A tier the order does not collect must not be able to hold a row
     * open. Unchanged from before the batch, deliberately.
     */
    const { db, repo } = seed("INTEREST_PRINCIPAL");
    await pay(repo, INSTALMENT_1);

    expect(money(db.inst(1).principalPaid)).toBe("8026.26");
    expect(money(db.inst(1).penaltyPaid)).toBe("0.00");
    expect(db.inst(1).paidInFullAt).toEqual(PAID_ON);
  });
});

// ─── 3. Paying the schedule now settles the fee ─────────────────────────

describe("GOLDEN — the borrower can pay the late fee", () => {
  it("clears all 310.00 of penalty out of the same ₱26,328.78", async () => {
    /*
     * The headline, and the reversal of the one this file was written to
     * record. Total schedule = 8,776.26 x 3 = 26,328.78.
     *
     * WAS: every instalment settled, loan CLOSED, all 310.00 still owing.
     * NOW: the penalty is settled and 310.00 of PRINCIPAL is left instead,
     * so the loan stays open. The borrower owes the same total either way;
     * the difference is that the schedule and the ledger now agree about
     * what it is, and the remaining 310.00 is collectable by the ordinary
     * payment path instead of sitting in a figure nothing could reduce.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26328.78");

    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 0,
      paidToDate: TOTAL_ACCRUED,
      outstanding: 0,
    });
    expect(outcome(db).progress).toEqual([
      ["750.00", "8026.26", "250.00", "settled"],
      ["629.61", "8146.65", "60.00", "settled"],
      // 310.00 of principal short — the money that used to leave as an
      // uncollectable penalty now stays visible as debt on the schedule.
      ["507.41", "7958.85", "0.00", "open"],
    ]);
    expect(db.loans[0]!.status).toBe("ACTIVE");
  });

  it("clears the loan outright when the borrower pays schedule + penalty", async () => {
    /*
     * WAS: 310.00 booked to Customer Advances while the borrower
     * simultaneously owed 310.00 of penalty — the same peso on both sides
     * of the balance sheet.
     * NOW: nothing to advances, nothing owing, loan CLOSED.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26638.78");

    expect(db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe("0.00");
    expect((await repo.accruedPenaltiesFor(LOAN_ID)).outstanding).toBe(0);
    expect(db.schedules.every((s) => s.paidInFullAt !== null)).toBe(true);
    expect(db.loans[0]!.status).toBe("CLOSED");
  });

  it("reaches the same figures from either penalty-collecting order", async () => {
    /*
     * A payment large enough to reach every tier of every instalment
     * settles the same amounts whichever order it walks them in — order
     * decides who loses out when the money runs short, not what is owed.
     * The legacy order is deliberately excluded: it has no penalty tier, so
     * it genuinely lands somewhere else, which is the §26 promise.
     */
    const figures = [] as Array<ReturnType<typeof outcome>>;
    for (const order of [
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
      "INTEREST_PRINCIPAL_FEES_PENALTIES",
    ] as const) {
      const { db, repo } = seed(order);
      await pay(repo, "26638.78");
      figures.push(outcome(db));
    }
    expect(figures[1]).toEqual(figures[0]);
  });

  it("leaves a legacy-order borrower exactly where they were", async () => {
    // Same payment, same loan, no penalty tier: all 310.00 still owing and
    // the surplus still an advance. Unchanged from before the batch.
    const { db, repo } = seed("INTEREST_PRINCIPAL");
    await pay(repo, "26638.78");

    expect(db.credited(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe("310.00");
    expect((await repo.accruedPenaltiesFor(LOAN_ID)).outstanding).toBe(
      TOTAL_ACCRUED,
    );
    expect(db.loans[0]!.status).toBe("CLOSED");
  });
});

// ─── 4. A waiver now lands on instalments ───────────────────────────────

describe("GOLDEN — waiving is attributed oldest instalment first", () => {
  it("puts the whole waiver on the oldest instalment that can absorb it", async () => {
    /*
     * WAS: the loan-level figure moved and not one schedule row changed —
     * there was no per-instalment figure for it to move.
     * NOW: 100.00 against instalment 1, which has 250.00 outstanding.
     *
     * Oldest-first because it is the allocator's own walk and the arrears
     * convention everywhere else in this system; a waiver is a concession
     * on the oldest arrears.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "Goodwill — first arrears",
      waivedById: OFFICER,
    });

    expect([1, 2, 3].map((n) => money(db.inst(n).penaltyWaived))).toEqual([
      "100.00",
      "0.00",
      "0.00",
    ]);
    expect(await repo.accruedPenaltiesFor(LOAN_ID)).toEqual({
      originalPenalty: TOTAL_ACCRUED,
      waivedToDate: 100,
      paidToDate: 0,
      outstanding: 210,
    });
  });

  it("spills onto the next instalment once the oldest is exhausted", async () => {
    // 280.00 against 250.00 on #1 and 60.00 on #2: #1 takes all 250.00 and
    // #2 takes the remaining 30.00. Whole instalments cleared in order,
    // which is what "we've written off your first month" means.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 280,
      reason: "Restructure concession",
      waivedById: OFFICER,
    });

    expect([1, 2, 3].map((n) => money(db.inst(n).penaltyWaived))).toEqual([
      "250.00",
      "30.00",
      "0.00",
    ]);
  });

  it("adds the per-instalment shares back up to the loan-level row", async () => {
    /*
     * The reconcilable identity the whole attribution exists for, and what
     * `runReconciliation`'s `penalty_subledger` check asserts across the
     * whole book: SUM(LoanSchedule.penaltyWaived) per loan must equal
     * SUM(PenaltyWaiver.waivedAmount) per loan.
     */
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "First",
      waivedById: OFFICER,
    });
    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 175,
      reason: "Second",
      waivedById: OFFICER,
    });

    const attributed = db.schedules.reduce(
      (s, r) => s + Number(money(r.penaltyWaived)),
      0,
    );
    const waived = db.waivers.reduce((s, w) => s + Number(w.waivedAmount), 0);
    expect(attributed).toBe(waived);
    expect(attributed).toBe(275);
    // 250.00 on #1, then 25.00 of #2's 60.00.
    expect([1, 2, 3].map((n) => money(db.inst(n).penaltyWaived))).toEqual([
      "250.00",
      "25.00",
      "0.00",
    ]);
  });

  it("reduces what the next payment collects, by the waived amount", async () => {
    // The waiver has to reach the borrower's wallet, not just a report.
    // 250.00 accrued on #1 less 100.00 waived leaves 150.00 collectable.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "Goodwill",
      waivedById: OFFICER,
    });
    await pay(repo, "5000.00");

    expect(money(db.inst(1).penaltyPaid)).toBe("150.00");
    expect(money(db.inst(1).principalPaid)).toBe("4100.00");
  });

  it("refuses to waive a penalty the borrower has already paid", async () => {
    /*
     * WAS: allowed, and vacuous — `waivePenalty` validated against
     * `accrued - alreadyWaived` because nothing could be collected, so a
     * full 310.00 waiver was accepted after the borrower had settled the
     * whole schedule.
     * NOW: refused. The outstanding figure is net of collections, so the
     * same peso cannot be both collected from the borrower and written off
     * again. Pinned before the change precisely so closing it would be a
     * decision rather than an accident.
     */
    const { repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    await pay(repo, "26638.78"); // schedule + the full 310.00 of penalty

    await expect(
      repo.waivePenalty(LOAN_ID, {
        waivedAmount: TOTAL_ACCRUED,
        reason: "Full waive after settlement",
        waivedById: OFFICER,
      }),
    ).rejects.toThrow(/exceeds outstanding penalty 0/);
  });

  it("closes a loan the waiver was the last thing holding open", async () => {
    /*
     * A penalty can be the only thing left owing on a loan, and when it is
     * forgiven the loan has to close. Otherwise it sits ACTIVE with nothing
     * outstanding, keeps appearing in the collections queue, and — because
     * `lateFeeFor` charges any row whose `paidInFullAt` is null — keeps
     * accruing late fees against a debt that no longer exists. That is the
     * mirror of the settlement clause in `recordPayment` and it has to live
     * in `waivePenalty` too.
     *
     * Constructed with the accrual on the LAST instalment: allocation is
     * oldest-first, so under the borrower-friendly order the shortfall on a
     * partial payment always lands on the final row. Paying the schedule
     * exactly covers all interest and principal and leaves only #3's 75.00
     * penalty.
     */
    const LAST_ONLY = [
      { scheduleId: "s-3", day: "2026-06-09", amount: "75.00" },
    ];
    const { db, repo } = seed("INTEREST_PRINCIPAL_FEES_PENALTIES", LAST_ONLY);
    await pay(repo, "26328.78");

    expect([1, 2, 3].map((n) => db.inst(n).paidInFullAt === null)).toEqual([
      false,
      false,
      true,
    ]);
    expect(db.loans[0]!.status).toBe("ACTIVE");

    await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 75,
      reason: "Written off on settlement",
      waivedById: OFFICER,
    });

    expect(db.inst(3).paidInFullAt).not.toBeNull();
    expect(db.loans[0]!.status).toBe("CLOSED");
  });

  it("still posts the reversal against the loan, not against an instalment", async () => {
    // The ledger entry is unchanged: one loan-level reversal per waiver,
    // keyed to the waiver id. The attribution lives in the subledger, which
    // is where a per-instalment figure belongs.
    const { db, repo } = seed("FEES_PENALTIES_INTEREST_PRINCIPAL");
    const { journalEntryId } = await repo.waivePenalty(LOAN_ID, {
      waivedAmount: 100,
      reason: "Goodwill",
      waivedById: OFFICER,
    });
    const entry = db.entries.find((e) => e.id === journalEntryId)!;
    expect(entry.source).toBe("PENALTY_WAIVE");
    expect(entry.sourceRefType).toBe("PenaltyWaiver");
    expect(entry.sourceRefId).not.toMatch(/^s-\d/);
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
   *
   * The only edit this block took when penalties became collectable was a
   * third column of "0.00" in each `progress` row — `outcome` now reports
   * `penaltyPaid`. Not one existing figure changed, which is the claim.
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
          ["750.00", "4250.00", "0.00", "open"],
          ["0.00", "0.00", "0.00", "open"],
          ["0.00", "0.00", "0.00", "open"],
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
          ["750.00", "8026.26", "0.00", "settled"],
          ["0.00", "0.00", "0.00", "open"],
          ["0.00", "0.00", "0.00", "open"],
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
          ["750.00", "8026.26", "0.00", "settled"],
          ["629.61", "8146.65", "0.00", "settled"],
          ["507.41", "8268.85", "0.00", "settled"],
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
      paidToDate: 0,
      outstanding: 0,
    });
  });

  it("issues no accrual lookup at all on the legacy order", async () => {
    /*
     * The safety property stated as work done rather than as arithmetic.
     * An order with no PENALTIES tier can never reduce a penalty, so
     * `recordPayment` does not read the accrual ledger for it — every loan
     * written before §26 runs exactly the queries it ran before this batch,
     * not merely the same sums.
     */
    const { db, repo } = seed("INTEREST_PRINCIPAL", ACCRUALS);
    db.accrualLookups = 0;
    await pay(repo, "5000.00");
    expect(db.accrualLookups).toBe(0);

    const other = seed("FEES_PENALTIES_INTEREST_PRINCIPAL", ACCRUALS);
    other.db.accrualLookups = 0;
    await pay(other.repo, "5000.00");
    expect(other.db.accrualLookups).toBe(1);
  });
});
