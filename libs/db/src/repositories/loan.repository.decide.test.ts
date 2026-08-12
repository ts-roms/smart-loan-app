import type { LoanApplication, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanNotDecidableError, LoanRepository } from "./loan.repository";

/**
 * Invariant: a loan is decided once, and only while it is still a
 * pending decision.
 *
 * `decide()` had NO status guard. It wrote the caller's status over
 * whatever was there, which left two holes:
 *
 *   1. Two concurrent approvals both succeeded — last writer won and
 *      both callers got a 200, so a four-eyes control could be
 *      satisfied twice by one double-click. This is the "Concurrent
 *      approval" case in §14 of the modernization brief.
 *
 *   2. Worse, and needing no concurrency at all: a DISBURSED, ACTIVE or
 *      CLOSED loan could be decided again. A funded loan could be
 *      rewound to APPROVED, or flipped to REJECTED with the money
 *      already out, the schedule already written and the journal entry
 *      already posted.
 *
 * The fix claims the transition with `status in DECIDABLE and status !=
 * target`. The second half is what closes the race without breaking the
 * two flows that legitimately re-decide a loan.
 */

const STATUS_STORE = { status: "SUBMITTED" as string };

/**
 * Prisma stand-in that models `updateMany`'s WHERE the way Postgres
 * would: the row only matches while its stored status satisfies both
 * the `in` list and the `not`.
 */
function fakePrisma(initial: string) {
  STATUS_STORE.status = initial;
  const client = {
    loanApplication: {
      findFirst: () => Promise.resolve({ id: "loan-1" }),
      findUnique: () => Promise.resolve({ status: STATUS_STORE.status }),
      findUniqueOrThrow: () =>
        Promise.resolve({
          id: "loan-1",
          status: STATUS_STORE.status,
        } as LoanApplication),
      updateMany: ({
        where,
        data,
      }: {
        where: { status: { in: readonly string[]; not: string } };
        data: { status: string };
      }) => {
        const s = STATUS_STORE.status;
        const matches = where.status.in.includes(s) && s !== where.status.not;
        if (!matches) return Promise.resolve({ count: 0 });
        STATUS_STORE.status = data.status;
        return Promise.resolve({ count: 1 });
      },
    },
  };
  return client as unknown as PrismaClient;
}

const decide = (repo: LoanRepository, status: "APPROVED" | "REJECTED") =>
  repo.decide("LN-1", { status, decidedById: "u1" });

describe("decide — the loan must still be a pending decision", () => {
  it("approves a submitted loan", async () => {
    const repo = new LoanRepository(fakePrisma("SUBMITTED"));
    const loan = await decide(repo, "APPROVED");
    expect(loan.status).toBe("APPROVED");
  });

  it("approves a loan under review", async () => {
    const repo = new LoanRepository(fakePrisma("UNDER_REVIEW"));
    expect((await decide(repo, "APPROVED")).status).toBe("APPROVED");
  });

  it("still allows reconsidering a rejected applicant", async () => {
    /*
     * Load-bearing. loans.service.ts documents this deliberately: an
     * AUTO_REJECT is final for the engine but "a rejected applicant can
     * be reconsidered by hand". A guard that only permitted SUBMITTED
     * and UNDER_REVIEW would have silently removed a real workflow.
     */
    const repo = new LoanRepository(fakePrisma("REJECTED"));
    expect((await decide(repo, "APPROVED")).status).toBe("APPROVED");
  });

  it("still allows pulling an approval back before money moves", async () => {
    const repo = new LoanRepository(fakePrisma("APPROVED"));
    expect((await decide(repo, "REJECTED")).status).toBe("REJECTED");
  });
});

describe("decide — the concurrent-approval race", () => {
  it("lets exactly one of two simultaneous approvals through", async () => {
    const repo = new LoanRepository(fakePrisma("SUBMITTED"));
    const results = await Promise.allSettled([
      decide(repo, "APPROVED"),
      decide(repo, "APPROVED"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      LoanNotDecidableError,
    );
  });

  it("refuses a second identical decision", async () => {
    const repo = new LoanRepository(fakePrisma("APPROVED"));
    await expect(decide(repo, "APPROVED")).rejects.toBeInstanceOf(
      LoanNotDecidableError,
    );
  });
});

describe("decide — loans that have moved past deciding", () => {
  // Money has moved for every one of these. Re-deciding would leave the
  // status contradicting a schedule and a journal entry that exist.
  const FUNDED = [
    "DISBURSED",
    "ACTIVE",
    "DEFAULTED",
    "CLOSED",
    "WRITTEN_OFF",
    "RESTRUCTURED",
  ];

  it.each(FUNDED)("refuses to decide a %s loan", async (status) => {
    const repo = new LoanRepository(fakePrisma(status));
    await expect(decide(repo, "REJECTED")).rejects.toBeInstanceOf(
      LoanNotDecidableError,
    );
  });

  it("leaves the status untouched when it refuses", async () => {
    const repo = new LoanRepository(fakePrisma("ACTIVE"));
    await expect(decide(repo, "REJECTED")).rejects.toThrow();
    expect(STATUS_STORE.status).toBe("ACTIVE");
  });

  it("names the status the operator can actually see", async () => {
    const repo = new LoanRepository(fakePrisma("DISBURSED"));
    await expect(decide(repo, "APPROVED")).rejects.toThrow(/DISBURSED/);
  });

  it("refuses a DRAFT — an application is submitted before it is judged", async () => {
    const repo = new LoanRepository(fakePrisma("DRAFT"));
    await expect(decide(repo, "APPROVED")).rejects.toBeInstanceOf(
      LoanNotDecidableError,
    );
  });
});
