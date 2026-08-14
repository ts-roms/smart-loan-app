import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { BankReconciliationRepository } from "./bank-reconciliation.repository";

/**
 * GOLDEN TESTS — `autoMatch`.
 *
 * Written against the CURRENT implementation and committed passing BEFORE any
 * F2 change (docs/modernization/query-performance.md), per §81.
 *
 * What the current implementation computes, exactly:
 *
 *   For each unmatched line of the statement, in query order:
 *     - amount > 0 is a credit → look for a `LoanPayment` with that exact
 *       amount and `paidOn` within ±2 days of the line's `txnDate`, take 5,
 *       then drop any payment already claimed by another statement line.
 *       Prefer a candidate whose `reference` equals the line's; otherwise
 *       accept only if exactly one candidate remains.
 *     - amount <= 0 is a debit → same shape against `LoanApplication` by
 *       `principal = abs(amount)` and `disbursedAt` in the window, with no
 *       reference preference: accept only if exactly one candidate remains.
 *     - On a match the line is UPDATEd with `matchedType`/`matchedRefId`/
 *       `matchedAt`, and `matchedAmount` accumulates the credit amount or the
 *       absolute debit amount.
 *
 * THE INVARIANT THESE TESTS EXIST FOR
 *
 * `claimedRefIds()` reads `BankStatementLine` rows that already carry a
 * `matchedRefId` — and the loop WRITES exactly those columns on every match.
 * So the claimed set is not loop-invariant: it grows as the loop proceeds,
 * and each iteration sees the claims made by the ones before it. That is the
 * mechanism enforcing one-to-one reconciliation, and the whole point of the
 * long comment above `claimedRefIds`.
 *
 * The tests below pin both directions of that dependency:
 *   - a payment claimed by an earlier line must not be matched again, and
 *   - removing an earlier line's candidate from contention can let a later
 *     line resolve a match it otherwise could not.
 *
 * Any change to F2 that makes the claimed set constant for the whole loop
 * breaks both. They are the reason the naive "hoist it, the result is
 * identical every time" reading of R2 is wrong.
 */

interface FakeLine {
  id: string;
  statementId: string;
  amount: string;
  txnDate: Date;
  reference: string | null;
  matchedType: string | null;
  matchedRefId: string | null;
  matchedAt: Date | null;
}

interface FakePayment {
  id: string;
  amount: string;
  paidOn: Date;
  reference: string | null;
}

interface FakeLoan {
  id: string;
  principal: string;
  disbursedAt: Date;
}

function d(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m - 1, day));
}

interface DateWindow {
  gte?: Date;
  lte?: Date;
}

function inWindow(v: Date, w: DateWindow | undefined): boolean {
  if (!w) return true;
  if (w.gte && v.getTime() < w.gte.getTime()) return false;
  if (w.lte && v.getTime() > w.lte.getTime()) return false;
  return true;
}

function harness(fixture: {
  lines: FakeLine[];
  payments: FakePayment[];
  loans: FakeLoan[];
}) {
  // Cloned so each test starts from the fixture and the loop's UPDATEs are
  // visible to later reads, exactly as they would be in Postgres.
  const lines = fixture.lines.map((l) => ({ ...l }));
  const counts = { claimedRefIds: 0, candidateQueries: 0, updates: 0 };

  const prisma = {
    bankStatementLine: {
      findMany: (args: {
        where: {
          statementId?: string;
          matchedAt?: null;
          matchedType?: string;
          matchedRefId?: { not: null };
          id?: { not: string };
        };
        select?: Record<string, boolean>;
      }) => {
        const w = args.where;
        // The claimedRefIds() shape.
        if (w.matchedType !== undefined) {
          counts.claimedRefIds += 1;
          return Promise.resolve(
            lines
              .filter(
                (l) =>
                  l.matchedType === w.matchedType &&
                  l.matchedRefId !== null &&
                  (w.id?.not === undefined || l.id !== w.id.not),
              )
              .map((l) => ({ matchedRefId: l.matchedRefId })),
          );
        }
        // The per-statement unmatched-line shape.
        return Promise.resolve(
          lines.filter(
            (l) =>
              l.statementId === w.statementId &&
              (w.matchedAt !== null || l.matchedAt === null),
          ),
        );
      },
      update: (args: {
        where: { id: string };
        data: { matchedType: string; matchedRefId: string; matchedAt: Date };
      }) => {
        counts.updates += 1;
        const row = lines.find((l) => l.id === args.where.id);
        if (!row) throw new Error(`no such line ${args.where.id}`);
        row.matchedType = args.data.matchedType;
        row.matchedRefId = args.data.matchedRefId;
        row.matchedAt = args.data.matchedAt;
        return Promise.resolve(row);
      },
    },
    loanPayment: {
      findMany: (args: {
        where: { amount: unknown; paidOn?: DateWindow };
        take?: number;
      }) => {
        counts.candidateQueries += 1;
        const want = Number(args.where.amount);
        const rows = fixture.payments
          .filter(
            (p) =>
              Number(p.amount) === want &&
              inWindow(p.paidOn, args.where.paidOn),
          )
          .slice(0, args.take ?? undefined);
        return Promise.resolve(rows);
      },
    },
    loanApplication: {
      findMany: (args: {
        where: { principal: unknown; disbursedAt?: DateWindow };
        take?: number;
      }) => {
        counts.candidateQueries += 1;
        const want = Number(args.where.principal);
        const rows = fixture.loans
          .filter(
            (l) =>
              Number(l.principal) === want &&
              inWindow(l.disbursedAt, args.where.disbursedAt),
          )
          .slice(0, args.take ?? undefined);
        return Promise.resolve(rows);
      },
    },
  };

  return {
    repo: new BankReconciliationRepository(prisma as unknown as PrismaClient),
    lines,
    counts,
  };
}

const PAYMENTS: FakePayment[] = [
  {
    id: "pay-1",
    amount: "1500.00",
    paidOn: d(2026, 6, 10),
    reference: "REF-A",
  },
  {
    id: "pay-2",
    amount: "1500.00",
    paidOn: d(2026, 6, 10),
    reference: "REF-B",
  },
  { id: "pay-3", amount: "2500.00", paidOn: d(2026, 6, 15), reference: null },
];

const LOANS: FakeLoan[] = [
  { id: "loan-1", principal: "30000.00", disbursedAt: d(2026, 6, 20) },
];

function statementLines(): FakeLine[] {
  const mk = (
    id: string,
    amount: string,
    date: Date,
    reference: string | null,
  ): FakeLine => ({
    id,
    statementId: "stmt-1",
    amount,
    txnDate: date,
    reference,
    matchedType: null,
    matchedRefId: null,
    matchedAt: null,
  });
  return [
    // Two credits of the same amount against two candidate payments.
    mk("line-1", "1500.00", d(2026, 6, 10), "REF-A"),
    mk("line-2", "1500.00", d(2026, 6, 10), null),
    // Two identical credits against a SINGLE candidate payment.
    mk("line-3", "2500.00", d(2026, 6, 15), null),
    mk("line-4", "2500.00", d(2026, 6, 15), null),
    // Two identical debits against a SINGLE candidate disbursement.
    mk("line-5", "-30000.00", d(2026, 6, 20), null),
    mk("line-6", "-30000.00", d(2026, 6, 20), null),
  ];
}

const FIXTURE = () => ({
  lines: statementLines(),
  payments: PAYMENTS,
  loans: LOANS,
});

describe("GOLDEN — autoMatch", () => {
  it("produces exactly this result over the whole statement", async () => {
    const { repo } = harness(FIXTURE());
    const result = await repo.autoMatch("stmt-1");

    expect(result.details).toEqual([
      { lineId: "line-1", matchedType: "LoanPayment", matchedRefId: "pay-1" },
      { lineId: "line-2", matchedType: "LoanPayment", matchedRefId: "pay-2" },
      { lineId: "line-3", matchedType: "LoanPayment", matchedRefId: "pay-3" },
      { lineId: "line-4", matchedType: null, matchedRefId: null },
      {
        lineId: "line-5",
        matchedType: "LoanDisbursement",
        matchedRefId: "loan-1",
      },
      { lineId: "line-6", matchedType: null, matchedRefId: null },
    ]);
    expect(result.matchedLines).toBe(4);
    expect(result.matchedAmount).toBe(35500);
  });

  it("never matches one payment to two statement lines", async () => {
    // line-3 and line-4 are indistinguishable and there is exactly one
    // candidate payment. Matching both would report the statement reconciled
    // while a real deposit went unaccounted for — the precise discrepancy
    // this feature exists to surface.
    const { repo, lines } = harness(FIXTURE());
    await repo.autoMatch("stmt-1");

    const claims = lines
      .filter((l) => l.matchedType === "LoanPayment")
      .map((l) => l.matchedRefId);
    expect(claims).toEqual(["pay-1", "pay-2", "pay-3"]);
    expect(new Set(claims).size).toBe(claims.length);
    expect(lines.find((l) => l.id === "line-4")?.matchedRefId).toBeNull();
  });

  it("never matches one disbursement to two statement lines", async () => {
    const { repo, lines } = harness(FIXTURE());
    await repo.autoMatch("stmt-1");
    expect(lines.find((l) => l.id === "line-5")?.matchedRefId).toBe("loan-1");
    expect(lines.find((l) => l.id === "line-6")?.matchedRefId).toBeNull();
  });

  it("lets an earlier claim narrow a later line to a single candidate", async () => {
    /*
     * The dependency in the other direction, and the reason a naive hoist
     * changes results rather than merely making them slower to compute.
     *
     * line-1 resolves by reference to pay-1. That removes pay-1 from
     * contention, which leaves line-2 with exactly one candidate (pay-2) and
     * so line-2 matches. Had the claimed set been captured once before the
     * loop, line-2 would still see two candidates, fail the
     * `candidates.length === 1` test, and go unmatched.
     */
    const { repo } = harness(FIXTURE());
    const result = await repo.autoMatch("stmt-1");
    expect(
      result.details.find((x) => x.lineId === "line-2")?.matchedRefId,
    ).toBe("pay-2");
  });

  it("respects the ±2 day window", async () => {
    const fixture = FIXTURE();
    fixture.lines = [
      {
        id: "line-far",
        statementId: "stmt-1",
        amount: "2500.00",
        // pay-3 is on 2026-06-15; three days away is outside the window.
        txnDate: d(2026, 6, 18),
        reference: null,
        matchedType: null,
        matchedRefId: null,
        matchedAt: null,
      },
    ];
    const { repo } = harness(fixture);
    const result = await repo.autoMatch("stmt-1");
    expect(result.matchedLines).toBe(0);
    expect(result.details[0]?.matchedRefId).toBeNull();
  });

  it("leaves a line unmatched when two candidates remain and no reference decides", async () => {
    const fixture = FIXTURE();
    fixture.lines = [
      {
        id: "line-ambiguous",
        statementId: "stmt-1",
        amount: "1500.00",
        txnDate: d(2026, 6, 10),
        reference: null,
        matchedType: null,
        matchedRefId: null,
        matchedAt: null,
      },
    ];
    const { repo } = harness(fixture);
    const result = await repo.autoMatch("stmt-1");
    expect(result.matchedLines).toBe(0);
  });

  it("reports zero for a statement with no unmatched lines", async () => {
    const fixture = FIXTURE();
    fixture.lines = [];
    const { repo } = harness(fixture);
    expect(await repo.autoMatch("stmt-1")).toEqual({
      matchedLines: 0,
      matchedAmount: 0,
      details: [],
    });
  });
});
