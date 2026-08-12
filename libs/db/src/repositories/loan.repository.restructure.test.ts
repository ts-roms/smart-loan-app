import type { LoanApplication, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * Invariant: one loan restructures once, whatever arrives concurrently.
 *
 * The last financial transition still doing check-then-act, a year after
 * the audit closed the same hole in disburse, closeEarly, writeOff and
 * decide. `restructure` read the loan, checked its status in JS, and
 * wrote — so two concurrent restructures both read ACTIVE, both passed,
 * and both created a replacement loan. The borrower's debt duplicated,
 * each copy with its own settlement rows and its own journal entry, and
 * every individual write looked correct.
 *
 * The fix is the claim idiom used by its siblings: `updateMany` with the
 * expected statuses in the WHERE, zero rows meaning someone else won.
 * The claim also moved AHEAD of the schedule settlement — the old code
 * settled instalments first and flipped status last, which would have
 * let the losing caller mark instalments paid on a loan it never won.
 *
 * The fake models the ONE database behaviour that matters here: a stale
 * read. `findFirst` returns the snapshot each caller took while the loan
 * was still ACTIVE; only `updateMany` consults live state. That is the
 * interleaving of the real race, and it is what the old code fails on —
 * the loser's JS check passed against its stale snapshot.
 */

interface State {
  status: string;
  settled: number;
  replacements: number;
}

const OPEN_INSTALMENT = {
  id: "s1",
  principalDue: 40_000,
  principalPaid: 0,
  interestDue: 4_000,
};

function fakePrisma(state: State, opts: { restructuredFromId?: string } = {}) {
  /** The snapshot a caller took before anyone won the race. */
  const snapshot = () => ({
    id: "L1",
    number: "LN-1",
    status: "ACTIVE",
    restructuredFromId: opts.restructuredFromId ?? null,
    creditScoreAtApply: 700,
    tierAtApply: "B",
    customerId: "c1",
    customer: { id: "c1" },
    schedule: [{ ...OPEN_INSTALMENT }],
  });

  const client = {
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
    loanApplication: {
      findFirst: () => Promise.resolve(snapshot()),
      /**
       * The claim. Honours the status list in the WHERE against LIVE
       * state — modelling this faithfully is the whole test; a stub
       * that always returned count 1 would pass the old code too.
       */
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status?: { in: string[] } };
        data: { status: string };
      }) => {
        const statusOk =
          !where.status || where.status.in.includes(state.status);
        if (where.id !== "L1" || !statusOk) {
          return Promise.resolve({ count: 0 });
        }
        state.status = data.status;
        return Promise.resolve({ count: 1 });
      },
      findUnique: () => Promise.resolve({ status: state.status }),
      findUniqueOrThrow: () =>
        Promise.resolve({ ...snapshot(), status: state.status }),
      /**
       * The OLD code's unguarded write. The fixed code never calls it,
       * but it stays modelled so that running this suite against the
       * old implementation demonstrates the actual defect — two
       * replacements created — instead of crashing on a missing stub
       * and "failing" for a reason that proves nothing.
       */
      update: ({ data }: { data: { status?: string } }) => {
        if (data.status) state.status = data.status;
        return Promise.resolve({ ...snapshot(), status: state.status });
      },
    },
    loanSchedule: {
      update: () => {
        state.settled += 1;
        return Promise.resolve({});
      },
    },
  };
  return client as unknown as PrismaClient;
}

/** Stub the parts past the claim: loan creation and the journal post. */
function stubTail(repo: LoanRepository, state: State) {
  (repo as unknown as { applyInTx: () => Promise<LoanApplication> }).applyInTx =
    () => {
      state.replacements += 1;
      return Promise.resolve({
        id: "L2",
        number: "LN-2",
      } as LoanApplication);
    };
  (repo as unknown as { accounting: unknown }).accounting = {
    postIfAbsent: () => Promise.resolve(null),
  };
}

const INPUT = {
  restructuredById: "officer-1",
  productCode: "SALARY",
  principal: 40_000,
  termMonths: 12,
  annualInterestRate: 0.18,
};

let state: State;

beforeEach(() => {
  state = { status: "ACTIVE", settled: 0, replacements: 0 };
});

describe("restructure — the claim", () => {
  it("restructures an ACTIVE loan once, settling its open instalments", async () => {
    const repo = new LoanRepository(fakePrisma(state));
    stubTail(repo, state);

    const result = await repo.restructure("LN-1", INPUT);

    expect(result.original.status).toBe("RESTRUCTURED");
    expect(result.replacement.number).toBe("LN-2");
    expect(state.replacements).toBe(1);
    expect(state.settled).toBe(1);
  });

  it("refuses the loser of a race, and creates no second replacement", async () => {
    /*
     * The defect, replayed. Both callers hold a snapshot that says
     * ACTIVE — findFirst here always returns one, which IS the stale
     * read of the real interleaving. The first claim flips live state
     * to RESTRUCTURED; the second matches zero rows. Under the old
     * code the second caller's JS check passed against its snapshot
     * and it went on to build a duplicate loan.
     */
    const repo = new LoanRepository(fakePrisma(state));
    stubTail(repo, state);

    await repo.restructure("LN-1", INPUT);
    const settledAfterWinner = state.settled;

    await expect(repo.restructure("LN-1", INPUT)).rejects.toThrow(
      "Cannot restructure from status RESTRUCTURED",
    );

    expect(state.replacements).toBe(1);
    // The loser settled nothing — the claim precedes settlement.
    expect(state.settled).toBe(settledAfterWinner);
  });

  it("refuses a status outside the restructurable set, touching nothing", async () => {
    state.status = "CLOSED";
    const repo = new LoanRepository(fakePrisma(state));
    stubTail(repo, state);

    await expect(repo.restructure("LN-1", INPUT)).rejects.toThrow(
      "Cannot restructure from status CLOSED",
    );

    expect(state.replacements).toBe(0);
    expect(state.settled).toBe(0);
    expect(state.status).toBe("CLOSED");
  });

  it("still refuses to chain restructures, before any write", async () => {
    const repo = new LoanRepository(
      fakePrisma(state, { restructuredFromId: "L0" }),
    );
    stubTail(repo, state);

    await expect(repo.restructure("LN-1", INPUT)).rejects.toThrow(
      /Cannot chain restructures/,
    );

    // The chain check outranks the claim: a refused chain must not
    // have consumed the loan's one transition.
    expect(state.status).toBe("ACTIVE");
    expect(state.settled).toBe(0);
  });
});
