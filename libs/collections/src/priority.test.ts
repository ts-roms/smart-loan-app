/**
 * Collection priority — §29.
 *
 * These tests assert the ORDERING more than the numbers. The score is an
 * uncalibrated policy (see weights.ts), so pinning exact values would
 * lock in arithmetic nobody has validated and would break on every
 * legitimate retune. What must hold across a retune is the ranking: the
 * account a collections manager would want called first has to come out
 * first, or the score has no business replacing the sort by days
 * overdue.
 */

import { describe, expect, it } from "vitest";

import {
  computeCollectionPriority,
  type PriorityInput,
  type PriorityResult,
} from "./priority";
import { COLLECTION_PRIORITY_WEIGHTS, UNSOURCED_FACTORS } from "./weights";

const ASOF = new Date("2026-08-12T00:00:00.000Z");

/** Baseline account: mid-size balance, reachable, no history either way. */
function account(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    asOf: ASOF,
    loanStatus: "ACTIVE",
    daysOverdue: 0,
    outstanding: 100_000,
    riskGrade: "C",
    promises: [],
    contact: {
      phone: "+639170000000",
      secondaryPhone: null,
      email: "borrower@example.com",
      lastContactAt: null,
    },
    history: { priorLoansClosed: 0, priorLoansDefaulted: 0 },
    collateralValue: null,
    ...overrides,
  };
}

const daysAgo = (n: number): Date => new Date(ASOF.getTime() - n * 86_400_000);
const daysAhead = (n: number): Date =>
  new Date(ASOF.getTime() + n * 86_400_000);

/** Rank a set of named accounts, highest priority first. */
function rank(
  accounts: Record<string, PriorityInput>,
): Array<{ name: string; result: PriorityResult }> {
  return Object.entries(accounts)
    .map(([name, input]) => ({
      name,
      result: computeCollectionPriority(input),
    }))
    .sort((a, b) => b.result.score - a.result.score);
}

const names = (ranked: ReturnType<typeof rank>): string[] =>
  ranked.map((r) => r.name);

// ─── The headline ordering ─────────────────────────────────────────────

describe("the queue ordering", () => {
  /**
   * The scenario the whole feature exists for. Under the old
   * sort-by-DPD, `staleSmallHopeless` was first every morning and
   * `bigRecentSecured` was somewhere below the fold.
   */
  it("puts a large, recent, secured, reachable account above a small, ancient, unsecured, unreachable one", () => {
    const ranked = rank({
      bigRecentSecured: account({
        daysOverdue: 40,
        outstanding: 380_000,
        collateralValue: 450_000,
        riskGrade: "B",
      }),
      staleSmallHopeless: account({
        daysOverdue: 1_100,
        outstanding: 6_000,
        collateralValue: null,
        contact: {
          phone: null,
          secondaryPhone: null,
          email: null,
          lastContactAt: null,
        },
        history: { priorLoansClosed: 0, priorLoansDefaulted: 2 },
        riskGrade: "F",
      }),
    });

    expect(names(ranked)[0]).toBe("bigRecentSecured");
  });

  it("ranks the six canonical accounts in the order a collector should work them", () => {
    const ranked = rank({
      // Terminal. Not worked at all.
      writtenOff: account({
        loanStatus: "WRITTEN_OFF",
        daysOverdue: 900,
        outstanding: 250_000,
      }),
      // Nothing past due.
      current: account({ daysOverdue: 0, outstanding: 100_000 }),
      // Committed to pay next week — chasing now breaks the promise.
      keptPromise: account({
        daysOverdue: 45,
        outstanding: 100_000,
        promises: [
          { status: "HONORED", promisedDate: daysAgo(60) },
          { status: "PROMISED", promisedDate: daysAhead(6) },
        ],
      }),
      // Mildly late, nothing else remarkable.
      mildlyLate: account({ daysOverdue: 20, outstanding: 100_000 }),
      // Same age, but has broken every commitment made.
      brokenPromise: account({
        daysOverdue: 45,
        outstanding: 100_000,
        promises: [
          { status: "BROKEN", promisedDate: daysAgo(60) },
          { status: "BROKEN", promisedDate: daysAgo(20) },
        ],
      }),
      // Deeply delinquent, large, and going nowhere.
      deeplyDelinquent: account({
        daysOverdue: 200,
        outstanding: 300_000,
        riskGrade: "F",
        history: { priorLoansClosed: 0, priorLoansDefaulted: 1 },
      }),
    });

    expect(names(ranked)).toEqual([
      "deeplyDelinquent",
      "brokenPromise",
      // `mildlyLate` sits ABOVE `keptPromise` despite being less than
      // half as overdue, and that inversion is the feature working
      // rather than a bug in the weights.
      //
      // `keptPromise` is 45 days down but has honoured every commitment
      // and owes money on a promise that falls due in six days; its
      // recommended action is AWAIT_PROMISE, i.e. explicitly do not
      // chase it today. `mildlyLate` is 20 days down with no promise,
      // no contact logged and nobody working it. Of the two, the one
      // to spend the morning on is the drifting account, not the one
      // that already said yes.
      //
      // A queue sorted by days overdue gets this backwards every time.
      "mildlyLate",
      "keptPromise",
      "current",
      "writtenOff",
    ]);
  });

  it("puts a broken-promise account above a kept-promise one of identical age", () => {
    // The clean comparison behind the inversion above: hold age fixed
    // and only the promise history moves.
    const ranked = rank({
      brokenPromise: account({
        daysOverdue: 45,
        promises: [{ status: "BROKEN", promisedDate: daysAgo(20) }],
      }),
      keptPromise: account({
        daysOverdue: 45,
        promises: [{ status: "HONORED", promisedDate: daysAgo(20) }],
      }),
    });
    expect(names(ranked)).toEqual(["brokenPromise", "keptPromise"]);
  });
});

// ─── Individual factors, each isolated ────────────────────────────────

describe("delinquency depth", () => {
  it("ranks deeper arrears above shallower, all else equal", () => {
    const ranked = rank({
      current: account({ daysOverdue: 0 }),
      mild: account({ daysOverdue: 15 }),
      moderate: account({ daysOverdue: 75 }),
      deep: account({ daysOverdue: 200 }),
    });
    expect(names(ranked)).toEqual(["deep", "moderate", "mild", "current"]);
  });

  it("reuses §28's seven aging bands rather than its own thresholds", () => {
    // The band boundaries are inclusive of their upper bound — 90 is
    // still D_61_90, 91 is the first non-performing day.
    expect(
      computeCollectionPriority(account({ daysOverdue: 90 })).agingBucket,
    ).toBe("D_61_90");
    expect(
      computeCollectionPriority(account({ daysOverdue: 91 })).agingBucket,
    ).toBe("D_91_120");
    expect(
      computeCollectionPriority(account({ daysOverdue: 0 })).agingBucket,
    ).toBe("CURRENT");
    expect(
      computeCollectionPriority(account({ daysOverdue: 5_000 })).agingBucket,
    ).toBe("D_180_PLUS");
  });

  it("flattens beyond 180 days instead of climbing forever", () => {
    // Otherwise the score just rebuilds sort-by-DPD inside itself.
    const oneYear = computeCollectionPriority(account({ daysOverdue: 365 }));
    const tenYears = computeCollectionPriority(account({ daysOverdue: 3_650 }));
    expect(tenYears.score).toBe(oneYear.score);
  });
});

describe("promise to pay", () => {
  it("ranks a borrower who broke their promises above one who kept them", () => {
    const ranked = rank({
      broken: account({
        daysOverdue: 45,
        promises: [
          { status: "BROKEN", promisedDate: daysAgo(40) },
          { status: "BROKEN", promisedDate: daysAgo(10) },
        ],
      }),
      kept: account({
        daysOverdue: 45,
        promises: [
          { status: "HONORED", promisedDate: daysAgo(40) },
          { status: "HONORED", promisedDate: daysAgo(10) },
        ],
      }),
    });
    expect(names(ranked)).toEqual(["broken", "kept"]);
  });

  it("treats no promise history as neutral, between kept and broken", () => {
    const ranked = rank({
      broken: account({
        daysOverdue: 45,
        promises: [{ status: "BROKEN", promisedDate: daysAgo(10) }],
      }),
      none: account({ daysOverdue: 45, promises: [] }),
      kept: account({
        daysOverdue: 45,
        promises: [{ status: "HONORED", promisedDate: daysAgo(10) }],
      }),
    });
    // Absence of evidence must not score as evidence of bad faith.
    expect(names(ranked)).toEqual(["broken", "none", "kept"]);
  });

  it("ignores cancelled promises — a withdrawn promise says nothing", () => {
    const cancelled = computeCollectionPriority(
      account({
        daysOverdue: 45,
        promises: [{ status: "CANCELLED", promisedDate: daysAgo(10) }],
      }),
    );
    const none = computeCollectionPriority(
      account({ daysOverdue: 45, promises: [] }),
    );
    expect(cancelled.score).toBe(none.score);
  });

  it("holds off on an account with an open promise not yet due", () => {
    const result = computeCollectionPriority(
      account({
        daysOverdue: 45,
        promises: [{ status: "PROMISED", promisedDate: daysAhead(6) }],
      }),
    );
    expect(result.action).toBe("AWAIT_PROMISE");
    // Follow up the day AFTER it falls due, not before.
    expect(result.nextFollowUpDate).toEqual(daysAhead(7));
  });

  it("does not hold off on a promise whose date has already passed", () => {
    // A PROMISED row past its date is a promise nobody resolved. It is
    // not a reason to leave the account alone.
    const result = computeCollectionPriority(
      account({
        daysOverdue: 45,
        promises: [{ status: "PROMISED", promisedDate: daysAgo(3) }],
      }),
    );
    expect(result.action).not.toBe("AWAIT_PROMISE");
    expect(result.action).toBe("CALL_BORROWER");
  });
});

describe("collateral", () => {
  it("ranks a secured account above an identical unsecured one", () => {
    // Deliberate: security is a live path to money, so it is a reason to
    // act rather than a reason to relax. See the weight's comment.
    const ranked = rank({
      secured: account({ daysOverdue: 60, collateralValue: 200_000 }),
      unsecured: account({ daysOverdue: 60, collateralValue: null }),
    });
    expect(names(ranked)).toEqual(["secured", "unsecured"]);
  });

  it("caps coverage at full — security worth 4x the balance is not 4x the priority", () => {
    const full = computeCollectionPriority(
      account({ outstanding: 100_000, collateralValue: 100_000 }),
    );
    const excessive = computeCollectionPriority(
      account({ outstanding: 100_000, collateralValue: 400_000 }),
    );
    expect(excessive.score).toBe(full.score);
  });

  it("sends a 180+ secured account to repossession and an unsecured one to legal", () => {
    expect(
      computeCollectionPriority(
        account({ daysOverdue: 200, collateralValue: 300_000 }),
      ).action,
    ).toBe("INITIATE_REPOSSESSION");
    expect(
      computeCollectionPriority(
        account({ daysOverdue: 200, collateralValue: null }),
      ).action,
    ).toBe("ESCALATE_LEGAL");
  });
});

describe("exposure", () => {
  it("ranks a larger balance above a smaller one at the same age", () => {
    const ranked = rank({
      large: account({ daysOverdue: 30, outstanding: 400_000 }),
      medium: account({ daysOverdue: 30, outstanding: 120_000 }),
      small: account({ daysOverdue: 30, outstanding: 8_000 }),
    });
    expect(names(ranked)).toEqual(["large", "medium", "small"]);
  });

  it("normalises against a fixed ceiling, not against the rest of the queue", () => {
    // The same account must score the same regardless of what else is
    // delinquent today, or yesterday's queue cannot be compared to
    // today's.
    const alone = computeCollectionPriority(
      account({ daysOverdue: 30, outstanding: 200_000 }),
    );
    const again = computeCollectionPriority(
      account({ daysOverdue: 30, outstanding: 200_000 }),
    );
    expect(alone.score).toBe(again.score);
    // And above the ceiling everything scores the same.
    const atCeiling = computeCollectionPriority(
      account({ outstanding: 500_000 }),
    );
    const wayAbove = computeCollectionPriority(
      account({ outstanding: 5_000_000 }),
    );
    expect(wayAbove.score).toBe(atCeiling.score);
  });
});

describe("contactability", () => {
  it("ranks a reachable account above an unreachable one", () => {
    const ranked = rank({
      reachable: account({
        daysOverdue: 45,
        contact: {
          phone: "+639170000000",
          secondaryPhone: "+639180000000",
          email: "a@example.com",
          lastContactAt: null,
        },
      }),
      unreachable: account({
        daysOverdue: 45,
        contact: {
          phone: null,
          secondaryPhone: null,
          email: null,
          lastContactAt: null,
        },
      }),
    });
    expect(names(ranked)).toEqual(["reachable", "unreachable"]);
  });

  it("pushes an account contacted today below one untouched for a fortnight", () => {
    const ranked = rank({
      cold: account({
        daysOverdue: 45,
        contact: { ...account().contact, lastContactAt: daysAgo(20) },
      }),
      justCalled: account({
        daysOverdue: 45,
        contact: { ...account().contact, lastContactAt: ASOF },
      }),
    });
    expect(names(ranked)).toEqual(["cold", "justCalled"]);
  });

  it("recommends a field visit when there is no phone or email on file", () => {
    const result = computeCollectionPriority(
      account({
        daysOverdue: 20,
        contact: {
          phone: null,
          secondaryPhone: null,
          email: null,
          lastContactAt: null,
        },
      }),
    );
    expect(result.channel).toBe("FIELD");
    expect(result.channelReason).toMatch(/no phone or email/i);
  });

  it("never recommends SMS to a borrower with no phone number", () => {
    const result = computeCollectionPriority(
      account({
        daysOverdue: 10,
        contact: {
          phone: null,
          secondaryPhone: null,
          email: "a@example.com",
          lastContactAt: null,
        },
      }),
    );
    expect(result.channel).toBe("EMAIL");
  });
});

describe("customer history and risk grade", () => {
  it("ranks a serial defaulter above someone with a clean record", () => {
    const ranked = rank({
      serial: account({
        daysOverdue: 45,
        history: { priorLoansClosed: 0, priorLoansDefaulted: 3 },
      }),
      neutral: account({
        daysOverdue: 45,
        history: { priorLoansClosed: 0, priorLoansDefaulted: 0 },
      }),
      clean: account({
        daysOverdue: 45,
        history: { priorLoansClosed: 5, priorLoansDefaulted: 0 },
      }),
    });
    expect(names(ranked)).toEqual(["serial", "neutral", "clean"]);
  });

  it("ranks a worse credit grade above a better one", () => {
    const ranked = rank({
      f: account({ daysOverdue: 45, riskGrade: "F" }),
      c: account({ daysOverdue: 45, riskGrade: "C" }),
      a: account({ daysOverdue: 45, riskGrade: "A" }),
    });
    expect(names(ranked)).toEqual(["f", "c", "a"]);
  });

  it("treats an unscored customer as neutral rather than as a bad risk", () => {
    const ranked = rank({
      poor: account({ daysOverdue: 45, riskGrade: "D" }),
      unscored: account({ daysOverdue: 45, riskGrade: null }),
      good: account({ daysOverdue: 45, riskGrade: "B" }),
    });
    expect(names(ranked)).toEqual(["poor", "unscored", "good"]);
  });
});

describe("written-off and terminal accounts", () => {
  it("drops a written-off account below every workable one", () => {
    const ranked = rank({
      // The largest, oldest account in the book — and terminal.
      writtenOff: account({
        loanStatus: "WRITTEN_OFF",
        daysOverdue: 900,
        outstanding: 500_000,
        riskGrade: "F",
      }),
      // The least urgent workable account there is.
      trivialCurrent: account({
        loanStatus: "ACTIVE",
        daysOverdue: 0,
        outstanding: 1_000,
        riskGrade: "A",
        history: { priorLoansClosed: 5, priorLoansDefaulted: 0 },
      }),
    });
    expect(names(ranked)).toEqual(["trivialCurrent", "writtenOff"]);
  });

  it("suppresses rather than hides it — recovery is still possible", () => {
    const result = computeCollectionPriority(
      account({ loanStatus: "WRITTEN_OFF", daysOverdue: 900 }),
    );
    expect(result.suppressed).toBe(true);
    expect(result.action).toBe("MONITOR_RECOVERY_ONLY");
    expect(result.score).toBeGreaterThan(0);
    // The reasoning survives suppression — it is still true and still
    // worth reading.
    expect(result.factors).toHaveLength(7);
  });

  it("still orders suppressed accounts among themselves by size", () => {
    const ranked = rank({
      bigWriteOff: account({
        loanStatus: "WRITTEN_OFF",
        daysOverdue: 900,
        outstanding: 400_000,
      }),
      smallWriteOff: account({
        loanStatus: "WRITTEN_OFF",
        daysOverdue: 900,
        outstanding: 4_000,
      }),
    });
    expect(names(ranked)).toEqual(["bigWriteOff", "smallWriteOff"]);
  });
});

// ─── Explainability and honesty ───────────────────────────────────────

describe("explainability", () => {
  it("returns one breakdown row per weighted factor, and they sum to the score", () => {
    const result = computeCollectionPriority(
      account({
        daysOverdue: 75,
        outstanding: 250_000,
        collateralValue: 90_000,
      }),
    );
    expect(result.factors).toHaveLength(
      Object.keys(COLLECTION_PRIORITY_WEIGHTS).length,
    );
    const summed = result.factors.reduce((s, f) => s + f.points, 0);
    expect(summed).toBeCloseTo(result.score, 2);
  });

  it("gives every factor a non-empty reason a collector can argue with", () => {
    const result = computeCollectionPriority(
      account({ daysOverdue: 75, collateralValue: 90_000 }),
    );
    for (const factor of result.factors) {
      expect(factor.source.length).toBeGreaterThan(0);
      expect(factor.label.length).toBeGreaterThan(0);
    }
    expect(result.actionReason.length).toBeGreaterThan(0);
    expect(result.channelReason.length).toBeGreaterThan(0);
    expect(result.followUpReason.length).toBeGreaterThan(0);
  });

  it("declares the two §29 inputs it cannot source, on every result", () => {
    // The score is six-and-a-bit factors, not eight, and says so rather
    // than letting a reader assume otherwise.
    const result = computeCollectionPriority(account());
    expect(result.missingFactors).toBe(UNSOURCED_FACTORS);
    expect(result.missingFactors.map((m) => m.requirement)).toEqual([
      "Probability of Payment",
      "Recovery Probability",
    ]);
  });

  it("keeps the score inside 0..100", () => {
    const worst = computeCollectionPriority(
      account({
        daysOverdue: 5_000,
        outstanding: 10_000_000,
        riskGrade: "F",
        collateralValue: 10_000_000,
        history: { priorLoansClosed: 0, priorLoansDefaulted: 4 },
        promises: [{ status: "BROKEN", promisedDate: daysAgo(5) }],
        contact: {
          phone: "+639170000000",
          secondaryPhone: "+639180000000",
          email: "a@example.com",
          lastContactAt: null,
        },
      }),
    );
    const best = computeCollectionPriority(
      account({
        daysOverdue: 0,
        outstanding: 0,
        riskGrade: "A",
        collateralValue: null,
        history: { priorLoansClosed: 9, priorLoansDefaulted: 0 },
        promises: [{ status: "HONORED", promisedDate: daysAgo(5) }],
        contact: {
          phone: null,
          secondaryPhone: null,
          email: null,
          lastContactAt: ASOF,
        },
      }),
    );
    expect(worst.score).toBeLessThanOrEqual(100);
    expect(best.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeGreaterThan(best.score);
  });
});

describe("recommended action", () => {
  it("escalates with the aging band", () => {
    const actionAt = (daysOverdue: number) =>
      computeCollectionPriority(account({ daysOverdue })).action;

    expect(actionAt(0)).toBe("SEND_REMINDER");
    expect(actionAt(15)).toBe("SEND_REMINDER");
    expect(actionAt(45)).toBe("CALL_BORROWER");
    expect(actionAt(75)).toBe("FIELD_VISIT");
    expect(actionAt(100)).toBe("ISSUE_DEMAND_LETTER");
    expect(actionAt(150)).toBe("FINAL_DEMAND");
    expect(actionAt(200)).toBe("ESCALATE_LEGAL");
  });

  it("serves every escalation in writing", () => {
    for (const days of [100, 150, 200]) {
      expect(
        computeCollectionPriority(account({ daysOverdue: days })).channel,
      ).toBe("LETTER");
    }
  });

  it("sets a nearer follow-up for urgent actions than for terminal ones", () => {
    const calling = computeCollectionPriority(account({ daysOverdue: 45 }));
    const monitoring = computeCollectionPriority(
      account({ loanStatus: "WRITTEN_OFF", daysOverdue: 900 }),
    );
    expect(calling.nextFollowUpDate.getTime()).toBeLessThan(
      monitoring.nextFollowUpDate.getTime(),
    );
    // And always in the future.
    expect(calling.nextFollowUpDate.getTime()).toBeGreaterThan(ASOF.getTime());
  });
});

describe("purity", () => {
  it("depends only on its inputs — same input, same result", () => {
    const input = account({ daysOverdue: 75, outstanding: 250_000 });
    const a = computeCollectionPriority(input);
    const b = computeCollectionPriority(input);
    expect(a).toEqual(b);
  });

  it("takes `asOf` rather than reading the clock", () => {
    // Same account, evaluated a week later, is a week further overdue —
    // but only because the caller says so.
    const early = computeCollectionPriority(
      account({ asOf: ASOF, daysOverdue: 45 }),
    );
    const later = computeCollectionPriority(
      account({ asOf: daysAhead(7), daysOverdue: 45 }),
    );
    expect(later.nextFollowUpDate.getTime()).toBeGreaterThan(
      early.nextFollowUpDate.getTime(),
    );
    expect(later.score).toBe(early.score);
  });
});
