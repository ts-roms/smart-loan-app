import type { LoanPayment, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * Invariant: a repeated payment request creates no second payment.
 *
 * The P0 from the Phase 0 audit. `recordPayment` validated the loan
 * status and wrote — no duplicate detection anywhere. A timeout the
 * caller never saw, a double-submitted form, or an at-least-once
 * provider callback each produced a SECOND real payment, leaving the
 * borrower's balance wrong in their favour against cash that never
 * existed.
 *
 * A payment cannot be protected the way a disbursement can. Disbursement
 * is one-shot, so claiming the state transition is enough; a payment is
 * legitimately repeatable — a borrower may really pay twice in one day —
 * so only a caller-supplied key can tell "again" from "twice".
 *
 * The guarantee is the unique index on LoanPayment.idempotencyKey. The
 * lookups here are the fast path; the catch is what makes it correct
 * when two requests arrive together.
 */

const KEY = "retry-abc123";

function payment(id: string): LoanPayment {
  return { id, idempotencyKey: KEY } as LoanPayment;
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error(
    "Unique constraint failed on the fields: (`idempotencyKey`)",
  ) as Error & { code: string };
  err.code = "P2002";
  return err;
}

/** Stand-in exposing only what the replay path touches. */
function fakePrisma(existing: LoanPayment | null) {
  const state = { existing };
  const client = {
    loanPayment: { findUnique: () => Promise.resolve(state.existing) },
    __state: state,
  };
  return client as unknown as PrismaClient & { __state: typeof state };
}

/** Swap the posting body so no transaction or schedule work is needed. */
function stubPost(repo: LoanRepository, fn: () => Promise<LoanPayment>) {
  (
    repo as unknown as { recordPaymentUnsafe: () => Promise<LoanPayment> }
  ).recordPaymentUnsafe = fn;
}

const INPUT = {
  amount: 500,
  paidOn: new Date("2026-08-11T00:00:00.000Z"),
  recordedById: "u1",
  idempotencyKey: KEY,
};

describe("recordPayment — idempotency invariant", () => {
  it("replays the original payment instead of charging again", async () => {
    const prisma = fakePrisma(payment("first"));
    const repo = new LoanRepository(prisma);
    let posted = 0;
    stubPost(repo, () => {
      posted += 1;
      return Promise.resolve(payment("second"));
    });

    const result = await repo.recordPayment("LN-1", INPUT);

    expect(result.id).toBe("first");
    expect(posted).toBe(0);
  });

  it("posts normally when the key is new", async () => {
    const prisma = fakePrisma(null);
    const repo = new LoanRepository(prisma);
    stubPost(repo, () => Promise.resolve(payment("new")));

    const result = await repo.recordPayment("LN-1", INPUT);

    expect(result.id).toBe("new");
  });

  it("loses the race gracefully: P2002 yields the winner's payment", async () => {
    /*
     * Both requests read before either wrote — the interleaving a
     * pre-write lookup cannot defend against, and the reason the unique
     * index rather than the lookup is the guarantee.
     */
    const prisma = fakePrisma(null);
    const repo = new LoanRepository(prisma);
    stubPost(repo, () => {
      prisma.__state.existing = payment("winner");
      return Promise.reject(uniqueViolation());
    });

    const result = await repo.recordPayment("LN-1", INPUT);

    expect(result.id).toBe("winner");
  });

  it("rethrows a unique violation from a different constraint", async () => {
    const prisma = fakePrisma(null);
    const repo = new LoanRepository(prisma);
    stubPost(repo, () => Promise.reject(uniqueViolation()));

    await expect(repo.recordPayment("LN-1", INPUT)).rejects.toThrow(
      /Unique constraint/,
    );
  });

  it("does not swallow a genuine refusal", async () => {
    // A loan that cannot take payments must still fail loudly, key or no key.
    const prisma = fakePrisma(null);
    const repo = new LoanRepository(prisma);
    stubPost(repo, () => Promise.reject(new Error("Loan LN-1 is not payable")));

    await expect(repo.recordPayment("LN-1", INPUT)).rejects.toThrow(
      /not payable/,
    );
  });

  it("without a key, behaves exactly as before — two calls, two payments", async () => {
    /*
     * Idempotency is opt-in. A borrower paying twice in one day with no
     * key is two real payments, and refusing the second would be worse
     * than the bug this fixes.
     */
    const prisma = fakePrisma(payment("should-not-be-consulted"));
    const repo = new LoanRepository(prisma);
    let posted = 0;
    stubPost(repo, () => {
      posted += 1;
      return Promise.resolve(payment(`post-${posted}`));
    });

    const a = await repo.recordPayment("LN-1", {
      ...INPUT,
      idempotencyKey: undefined,
    });
    const b = await repo.recordPayment("LN-1", {
      ...INPUT,
      idempotencyKey: undefined,
    });

    expect(posted).toBe(2);
    expect(a.id).not.toBe(b.id);
  });
});
