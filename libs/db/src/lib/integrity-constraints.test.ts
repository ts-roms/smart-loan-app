/**
 * The two constraints, proven against a real Postgres.
 *
 * Every other test in this package drives a stand-in for Prisma, which is
 * the right shape for testing logic and the wrong shape entirely for
 * testing a constraint: a fake `delete` refuses whatever we tell it to
 * refuse, which proves only that we can write a mock. A foreign key and a
 * unique index live in the database, so the database is what has to
 * answer.
 *
 *   1. 20260814090000_financial_record_restrict — deleting a loan that has
 *      a posted payment is refused (and the money is what refuses it, not
 *      a service check that a script could walk past).
 *   2. 20260814100000_bank_line_match_unique — a second bank line claiming
 *      a payment another line already holds is refused.
 *
 * ── How this stays safe to run against a live database ──────────────────
 *
 * Every case runs inside an interactive transaction that ALWAYS rolls
 * back: the body throws `Rollback` after asserting, so nothing it wrote
 * survives and no row that was already there is touched. Row counts before
 * and after a run are identical.
 *
 * Note the ordering constraint this imposes. A failed statement aborts the
 * enclosing Postgres transaction, so the statement we expect to be refused
 * has to be the LAST one in its transaction — anything after it would come
 * back as 25P02 and tell us nothing. Hence one transaction per assertion
 * rather than one per test.
 *
 * ── Why it skips instead of failing when there is no database ───────────
 *
 * `nx test` runs with no DATABASE_URL and no Postgres, and this package
 * has no fixture harness to spin one up. Rather than pretend, the suite
 * skips when it cannot reach a database, and runs for real when pointed at
 * one:
 *
 *   DATABASE_URL=postgres://loan:loan@127.0.0.1:5433/smart_loan \
 *     pnpm --filter @loan/db test -- integrity-constraints
 *
 * (127.0.0.1, not localhost — the dev Postgres refuses the latter and
 * reports it as a P1000 auth failure, which is a red herring.)
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/** Thrown to unwind the transaction once the assertion has been made. */
class Rollback extends Error {}

/**
 * Prisma error codes, matched structurally rather than with `instanceof
 * PrismaClientKnownRequestError` — under pnpm this package and the client
 * can resolve separate copies of @prisma/client, and an instanceof across
 * two copies silently returns false. Same reasoning as
 * `isUniqueViolation` in ./prisma-errors.
 */
function codeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

const prisma = process.env.DATABASE_URL ? new PrismaClient() : null;

/** Enough of a real database to build a loan on. Reused, never mutated —
 * everything we create is rolled back. */
const seed = prisma
  ? await (async () => {
      try {
        const [customer, user] = await Promise.all([
          prisma.customer.findFirst({ select: { id: true } }),
          prisma.user.findFirst({ select: { id: true } }),
        ]);
        return customer && user
          ? { customerId: customer.id, userId: user.id }
          : null;
      } catch {
        return null;
      }
    })()
  : null;

afterAll(async () => {
  await prisma?.$disconnect();
});

/** Run `fn` in a transaction that is always rolled back. */
async function inRollback(
  fn: (
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  ) => Promise<void>,
) {
  try {
    await prisma!.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

const uniq = () => Math.random().toString(36).slice(2, 10).toUpperCase();

describe.skipIf(!seed)("financial records refuse to be cascaded away", () => {
  /** A loan with one posted payment against it. */
  async function loanWithPayment(
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  ) {
    const loan = await tx.loanApplication.create({
      data: {
        number: `TEST-${uniq()}`,
        customerId: seed!.customerId,
        submittedById: seed!.userId,
        principal: 10_000,
        termMonths: 12,
        annualInterestRate: 12,
      },
      select: { id: true },
    });
    const payment = await tx.loanPayment.create({
      data: { loanId: loan.id, amount: 500, recordedById: seed!.userId },
      select: { id: true },
    });
    return { loan, payment };
  }

  it("refuses to delete a loan that has a posted payment", async () => {
    await inRollback(async (tx) => {
      const { loan } = await loanWithPayment(tx);

      // The whole point: this used to succeed and take the payment with
      // it. Must be the last statement — it aborts the transaction.
      const err = await tx.loanApplication
        .delete({ where: { id: loan.id } })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(
        err,
        "deleting a loan with a payment must be refused",
      ).not.toBeNull();
      // P2003 = foreign key constraint failed.
      expect(codeOf(err)).toBe("P2003");
    });
  });

  it("refuses to delete a loan that has a schedule", async () => {
    await inRollback(async (tx) => {
      const loan = await tx.loanApplication.create({
        data: {
          number: `TEST-${uniq()}`,
          customerId: seed!.customerId,
          submittedById: seed!.userId,
          principal: 10_000,
          termMonths: 12,
          annualInterestRate: 12,
        },
        select: { id: true },
      });
      await tx.loanSchedule.create({
        data: {
          loanId: loan.id,
          installmentNo: 1,
          dueDate: new Date(),
          principalDue: 800,
          interestDue: 100,
          totalDue: 900,
        },
      });

      const err = await tx.loanApplication
        .delete({ where: { id: loan.id } })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(codeOf(err)).toBe("P2003");
    });
  });

  it("still lets the loan go once its money has been dealt with", async () => {
    // The constraint has to bite the PARENT delete without wedging the
    // system: clearing the children explicitly must still work, which is
    // what every legitimate teardown path (and the smoke fixtures) does.
    await inRollback(async (tx) => {
      const { loan } = await loanWithPayment(tx);
      await tx.loanPayment.deleteMany({ where: { loanId: loan.id } });
      await expect(
        tx.loanApplication.delete({ where: { id: loan.id } }),
      ).resolves.toBeTruthy();
    });
  });

  it("refuses to delete a journal entry that has lines", async () => {
    await inRollback(async (tx) => {
      const account = await tx.account.findFirst({ select: { id: true } });
      if (!account) return; // no chart of accounts in this database
      const entry = await tx.journalEntry.create({
        data: {
          number: `TEST-${uniq()}`,
          entryDate: new Date(),
          memo: "integrity test",
          postedById: seed!.userId,
        },
        select: { id: true },
      });
      await tx.journalLine.create({
        data: { entryId: entry.id, accountId: account.id, debit: 1, credit: 0 },
      });

      const err = await tx.journalEntry
        .delete({ where: { id: entry.id } })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(codeOf(err)).toBe("P2003");
    });
  });
});

describe.skipIf(!seed)("a bank line cannot claim a record twice", () => {
  async function statementWithLines(
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
    count: number,
  ) {
    const statement = await tx.bankStatement.create({
      data: {
        label: `TEST-${uniq()}`,
        bankAccount: "TEST-ACCOUNT",
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-31"),
        openingBalance: 0,
        closingBalance: 0,
      },
      select: { id: true },
    });
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(
        await tx.bankStatementLine.create({
          data: {
            statementId: statement.id,
            txnDate: new Date("2026-08-10"),
            description: `line ${i}`,
            amount: 500,
          },
          select: { id: true },
        }),
      );
    }
    return { statement, lines };
  }

  it("refuses a second line claiming the same payment", async () => {
    await inRollback(async (tx) => {
      const { lines } = await statementWithLines(tx, 2);
      const refId = `payment-${uniq()}`;

      await tx.bankStatementLine.update({
        where: { id: lines[0]!.id },
        data: {
          matchedType: "LoanPayment",
          matchedRefId: refId,
          matchedAt: new Date(),
        },
      });

      // The check-then-act window: nothing here read first, and it does
      // not matter — the index arbitrates. Last statement in the tx.
      const err = await tx.bankStatementLine
        .update({
          where: { id: lines[1]!.id },
          data: {
            matchedType: "LoanPayment",
            matchedRefId: refId,
            matchedAt: new Date(),
          },
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(
        err,
        "a second claim on one payment must be refused",
      ).not.toBeNull();
      // P2002 = unique constraint failed.
      expect(codeOf(err)).toBe("P2002");
    });
  });

  it("refuses a second line claiming the same disbursement", async () => {
    await inRollback(async (tx) => {
      const { lines } = await statementWithLines(tx, 2);
      const refId = `loan-${uniq()}`;

      await tx.bankStatementLine.update({
        where: { id: lines[0]!.id },
        data: { matchedType: "LoanDisbursement", matchedRefId: refId },
      });
      const err = await tx.bankStatementLine
        .update({
          where: { id: lines[1]!.id },
          data: { matchedType: "LoanDisbursement", matchedRefId: refId },
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(codeOf(err)).toBe("P2002");
    });
  });

  it("leaves unmatched lines and refId-less MANUAL matches alone", async () => {
    // The index is PARTIAL for these two reasons, so they are the cases
    // that would break if someone ever "simplified" it to a plain
    // @@unique. Unmatched lines are the normal state and there are many
    // of them; MANUAL means "explained, not tied to a record" and several
    // lines are legitimately explained the same way.
    await inRollback(async (tx) => {
      const { lines } = await statementWithLines(tx, 3);

      // Three lines, all unmatched (both columns null) — no collision.
      const stillUnmatched = await tx.bankStatementLine.count({
        where: { id: { in: lines.map((l) => l.id) }, matchedType: null },
      });
      expect(stillUnmatched).toBe(3);

      // Two MANUAL matches with no refId — allowed.
      for (const line of lines.slice(0, 2)) {
        await tx.bankStatementLine.update({
          where: { id: line.id },
          data: {
            matchedType: "MANUAL",
            matchedRefId: null,
            matchedAt: new Date(),
            matchNote: "bank fee",
          },
        });
      }
      const manual = await tx.bankStatementLine.count({
        where: { id: { in: lines.map((l) => l.id) }, matchedType: "MANUAL" },
      });
      expect(manual).toBe(2);
    });
  });

  it("lets a released record be claimed by a different line", async () => {
    // Unmatch has to actually free the record, or a mistaken match would
    // be permanent.
    await inRollback(async (tx) => {
      const { lines } = await statementWithLines(tx, 2);
      const refId = `payment-${uniq()}`;

      await tx.bankStatementLine.update({
        where: { id: lines[0]!.id },
        data: { matchedType: "LoanPayment", matchedRefId: refId },
      });
      await tx.bankStatementLine.update({
        where: { id: lines[0]!.id },
        data: { matchedType: null, matchedRefId: null, matchedAt: null },
      });
      await expect(
        tx.bankStatementLine.update({
          where: { id: lines[1]!.id },
          data: { matchedType: "LoanPayment", matchedRefId: refId },
        }),
      ).resolves.toBeTruthy();
    });
  });
});
