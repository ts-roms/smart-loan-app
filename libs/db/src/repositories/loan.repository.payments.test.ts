import { ACCOUNT_CODES, DEFAULT_CHART_OF_ACCOUNTS } from "@loan/accounting";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * Regression tests for `LoanRepository.recordPayment`.
 *
 * These run against an in-memory stand-in for Prisma rather than a real
 * database. That's deliberate: the defects being pinned down here are all
 * about *what gets written* — the interest/principal split on the journal
 * entry, the per-installment progress columns, and when an installment
 * flips to paid — none of which need Postgres to observe, and all of which
 * were invisible to the existing unit tests because the buggy entries
 * balanced perfectly on their own.
 *
 * What was wrong before:
 *
 *   1. Allocation ran against each open installment's FULL interestDue,
 *      so every partial payment recognized the same interest again. One
 *      installment of 1,000 interest + 4,000 principal paid as five
 *      1,000s booked 5,000 of interest income and zero principal.
 *
 *   2. The marking loop compared a SINGLE payment's amount against
 *      `totalDue`, so an installment paid in two halves never got flagged
 *      — the loan never closed and late fees accrued against the borrower
 *      indefinitely.
 *
 *   3. Overpayment was folded into the principal credit, driving Loans
 *      Receivable below zero instead of raising a customer-advance
 *      liability.
 */

// ─── In-memory Prisma double ──────────────────────────────────────────────

interface FakeSchedule {
  id: string;
  loanId: string;
  installmentNo: number;
  dueDate: Date;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  principalPaid: number;
  interestPaid: number;
  paidInFullAt: Date | null;
}

interface FakeLine {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string;
}

interface FakeEntry {
  id: string;
  number: string;
  entryDate: Date;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  memo?: string;
  lines: FakeLine[];
}

class FakeDb {
  loans: Array<{
    id: string;
    number: string;
    status: string;
    closedAt: Date | null;
  }> = [];
  schedules: FakeSchedule[] = [];
  payments: Array<{
    id: string;
    loanId: string;
    amount: number;
    paidOn: Date;
  }> = [];
  entries: FakeEntry[] = [];
  accounts = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
    id: `acct-${a.code}`,
    code: a.code,
    active: true,
  }));
  periods: Array<{ id: string; year: number; month: number; status: string }> =
    [];
  private seq = 0;

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** Total credited to an account code across every posted entry. */
  creditedTo(code: string): number {
    const accountId = this.accounts.find((a) => a.code === code)?.id;
    return round2(
      this.entries
        .flatMap((e) => e.lines)
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.credit, 0),
    );
  }

  /** Credits to an account code on the entry for one specific payment. */
  creditedToForPayment(paymentId: string, code: string): number {
    const accountId = this.accounts.find((a) => a.code === code)?.id;
    const entry = this.entries.find((e) => e.sourceRefId === paymentId);
    if (!entry) return 0;
    return round2(
      entry.lines
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.credit, 0),
    );
  }

  installment(no: number): FakeSchedule {
    const row = this.schedules.find((s) => s.installmentNo === no);
    if (!row) throw new Error(`No installment ${no}`);
    return row;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Builds the narrow slice of the Prisma surface `recordPayment` and
 * `AccountingRepository.postEntry` actually touch. Anything they don't call
 * is intentionally absent — an unexpected query should fail loudly rather
 * than return a plausible empty result.
 */
function makeClient(db: FakeDb): PrismaClient {
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),

    loanApplication: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.loans.find((l) => l.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const loan = db.loans.find((l) => l.id === where.id)!;
        Object.assign(loan, data);
        return loan;
      },
    },

    loanPayment: {
      create: async ({
        data,
      }: {
        data: { loanId: string; amount: number; paidOn: Date };
      }) => {
        const row = { id: db.nextId("pay"), ...data };
        db.payments.push(row);
        return row;
      },
    },

    loanSchedule: {
      findMany: async ({ where }: { where: { loanId: string } }) =>
        db.schedules
          .filter((s) => s.loanId === where.loanId && s.paidInFullAt === null)
          .sort((a, b) => a.installmentNo - b.installmentNo),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.schedules.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where: { loanId: string } }) =>
        db.schedules.filter(
          (s) => s.loanId === where.loanId && s.paidInFullAt === null,
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
          p = { id: db.nextId("period"), year, month, status: "OPEN" };
          db.periods.push(p);
        }
        return p;
      },
    },

    journalEntry: {
      // Serves two callers: the idempotency probe (by sourceRefId) and the
      // entry-number allocator (latest number in the year).
      findFirst: async ({
        where,
      }: {
        where: { sourceRefId?: string; source?: string };
      }) => {
        if (where.sourceRefId) {
          return (
            db.entries.find(
              (e) =>
                e.sourceRefId === where.sourceRefId &&
                e.source === where.source,
            ) ?? null
          );
        }
        return (
          [...db.entries].sort((a, b) => b.number.localeCompare(a.number))[0] ??
          null
        );
      },
      create: async ({
        data,
      }: {
        data: Record<string, unknown> & {
          lines: { create: FakeLine[] };
        };
      }) => {
        const entry: FakeEntry = {
          id: db.nextId("je"),
          number: data.number as string,
          entryDate: data.entryDate as Date,
          source: data.source as string,
          sourceRefType: (data.sourceRefType as string) ?? null,
          sourceRefId: (data.sourceRefId as string) ?? null,
          memo: data.memo as string,
          lines: data.lines.create,
        };
        db.entries.push(entry);
        return entry;
      },
    },
  };
  return client as unknown as PrismaClient;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const LOAN_ID = "loan-1";
const OFFICER = "user-1";
const DUE = new Date("2026-04-01");

/** Seeds one ACTIVE loan with the given installments. */
function seed(installments: Array<{ interest: number; principal: number }>): {
  db: FakeDb;
  repo: LoanRepository;
} {
  const db = new FakeDb();
  db.loans.push({
    id: LOAN_ID,
    number: "LN-2026-000001",
    status: "ACTIVE",
    closedAt: null,
  });
  installments.forEach((inst, idx) => {
    db.schedules.push({
      id: `sched-${idx + 1}`,
      loanId: LOAN_ID,
      installmentNo: idx + 1,
      dueDate: new Date(DUE.getTime() + idx * 30 * 86_400_000),
      principalDue: inst.principal,
      interestDue: inst.interest,
      totalDue: round2(inst.principal + inst.interest),
      principalPaid: 0,
      interestPaid: 0,
      paidInFullAt: null,
    });
  });
  return { db, repo: new LoanRepository(makeClient(db)) };
}

function pay(repo: LoanRepository, amount: number, day = 1) {
  return repo.recordPayment(LOAN_ID, {
    amount,
    paidOn: new Date(2026, 3, day),
    recordedById: OFFICER,
  });
}

/** Every posted entry must balance to the penny, individually. */
function expectAllEntriesBalance(db: FakeDb) {
  for (const e of db.entries) {
    const debits = e.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e.lines.reduce((s, l) => s + l.credit, 0);
    expect(round2(debits)).toBeCloseTo(round2(credits), 2);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("recordPayment — repeated partials summing to one installment", () => {
  let db: FakeDb;
  let repo: LoanRepository;

  beforeEach(() => {
    // One installment: 1,000 interest + 4,000 principal = 5,000.
    ({ db, repo } = seed([{ interest: 1_000, principal: 4_000 }]));
  });

  it("recognizes the interest exactly once across five 1,000 partials", async () => {
    for (let i = 0; i < 5; i++) await pay(repo, 1_000, i + 1);

    // The headline number. Before the fix this was 5,000 / 0.
    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(1_000);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(4_000);
    expect(db.creditedTo(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(0);
  });

  it("puts the first payment against interest and the rest against principal", async () => {
    const p1 = await pay(repo, 1_000, 1);
    expect(db.creditedToForPayment(p1.id, ACCOUNT_CODES.INTEREST_INCOME)).toBe(
      1_000,
    );
    expect(db.creditedToForPayment(p1.id, ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(
      0,
    );

    const p2 = await pay(repo, 1_000, 2);
    // Interest is already fully collected — this one is all principal.
    expect(db.creditedToForPayment(p2.id, ACCOUNT_CODES.INTEREST_INCOME)).toBe(
      0,
    );
    expect(db.creditedToForPayment(p2.id, ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(
      1_000,
    );
  });

  it("accumulates progress on the installment as each partial lands", async () => {
    await pay(repo, 1_000, 1);
    expect(db.installment(1).interestPaid).toBe(1_000);
    expect(db.installment(1).principalPaid).toBe(0);

    await pay(repo, 1_000, 2);
    expect(db.installment(1).interestPaid).toBe(1_000);
    expect(db.installment(1).principalPaid).toBe(1_000);
  });

  it("leaves the installment open until the partials cover it in full", async () => {
    for (let i = 0; i < 4; i++) await pay(repo, 1_000, i + 1);
    expect(db.installment(1).paidInFullAt).toBeNull();
    expect(db.loans[0]!.status).toBe("ACTIVE");

    await pay(repo, 1_000, 5);
    expect(db.installment(1).paidInFullAt).not.toBeNull();
    expect(db.loans[0]!.status).toBe("CLOSED");
  });

  it("keeps every individual entry balanced", async () => {
    for (let i = 0; i < 5; i++) await pay(repo, 1_000, i + 1);
    expectAllEntriesBalance(db);
    // Cash received must equal the sum of everything credited.
    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(1_000);
  });
});

describe("recordPayment — cumulative marking (two halves of one installment)", () => {
  it("marks the installment paid once the halves add up, and closes the loan", async () => {
    // The stated repro: 5,000 installment settled as two 2,500s. Before the
    // fix neither payment alone covered `totalDue`, so the row stayed open
    // forever and `lateFeeFor` kept charging it.
    const { db, repo } = seed([{ interest: 1_000, principal: 4_000 }]);

    await pay(repo, 2_500, 1);
    expect(db.installment(1).paidInFullAt).toBeNull();

    await pay(repo, 2_500, 15);
    expect(db.installment(1).paidInFullAt).toEqual(new Date(2026, 3, 15));
    expect(db.loans[0]!.status).toBe("CLOSED");

    // And the split is still right: 1,000 interest, 4,000 principal.
    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(1_000);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(4_000);
  });
});

describe("recordPayment — a payment spanning two installments", () => {
  let db: FakeDb;
  let repo: LoanRepository;

  beforeEach(() => {
    // Two installments of 200 interest + 800 principal (1,000 each).
    ({ db, repo } = seed([
      { interest: 200, principal: 800 },
      { interest: 200, principal: 800 },
    ]));
  });

  it("settles the first installment and part-pays the second", async () => {
    await pay(repo, 1_500, 1);

    expect(db.installment(1).paidInFullAt).not.toBeNull();
    expect(db.installment(1).interestPaid).toBe(200);
    expect(db.installment(1).principalPaid).toBe(800);

    // 500 spilled onto #2: interest first, then principal.
    expect(db.installment(2).paidInFullAt).toBeNull();
    expect(db.installment(2).interestPaid).toBe(200);
    expect(db.installment(2).principalPaid).toBe(300);

    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(400);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(1_100);
  });

  it("charges no further interest on the second installment's remainder", async () => {
    await pay(repo, 1_500, 1);
    const p2 = await pay(repo, 500, 20);

    // #2's interest was already collected by the spillover — this 500 is
    // pure principal, not another 200 of interest income.
    expect(db.creditedToForPayment(p2.id, ACCOUNT_CODES.INTEREST_INCOME)).toBe(
      0,
    );
    expect(db.creditedToForPayment(p2.id, ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(
      500,
    );

    // Across the whole loan: interest == total interestDue, principal ==
    // total principalDue. Nothing double-counted, nothing lost.
    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(400);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(1_600);
    expect(db.loans[0]!.status).toBe("CLOSED");
    expectAllEntriesBalance(db);
  });
});

describe("recordPayment — overpayment", () => {
  it("books the excess as a customer advance, not as extra principal", async () => {
    const { db, repo } = seed([
      { interest: 200, principal: 800 },
      { interest: 200, principal: 800 },
    ]);

    // 2,500 against a 2,000 balance.
    await pay(repo, 2_500, 1);

    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(400);
    // Loans Receivable sees only the principal that existed. Crediting
    // 2,100 here — principal + overpayment — drove the asset negative.
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(1_600);
    expect(db.creditedTo(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(500);
    expectAllEntriesBalance(db);
  });

  it("settles every installment and closes the loan", async () => {
    const { db, repo } = seed([
      { interest: 200, principal: 800 },
      { interest: 200, principal: 800 },
    ]);
    await pay(repo, 2_500, 1);

    expect(db.schedules.every((s) => s.paidInFullAt !== null)).toBe(true);
    expect(db.loans[0]!.status).toBe("CLOSED");
  });

  it("treats a payment on an already-settled loan as pure advance", async () => {
    const { db, repo } = seed([{ interest: 200, principal: 800 }]);
    await pay(repo, 1_000, 1);
    const closedAt = db.loans[0]!.closedAt;

    await pay(repo, 300, 20);
    expect(db.creditedTo(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(300);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(800);
    // The original closure date survives — the stray payment doesn't
    // re-close the loan at a later date.
    expect(db.loans[0]!.closedAt).toBe(closedAt);
  });
});

describe("recordPayment — overpayment on top of partial progress", () => {
  it("credits only what is genuinely still owed before the advance kicks in", async () => {
    const { db, repo } = seed([{ interest: 200, principal: 800 }]);

    await pay(repo, 600, 1); // 200 interest + 400 principal
    await pay(repo, 1_000, 10); // 400 principal left, then 600 advance

    expect(db.creditedTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(200);
    expect(db.creditedTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(800);
    expect(db.creditedTo(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(600);
    expect(db.installment(1).paidInFullAt).not.toBeNull();
    expectAllEntriesBalance(db);
  });
});
