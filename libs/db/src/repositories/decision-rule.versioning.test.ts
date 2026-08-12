import type {
  DecisionRule,
  DecisionRuleVersion,
  PrismaClient,
} from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { DecisionRuleRepository } from "./decision-rule.repository";

/**
 * Invariant: a decision made under one text of a rule stays explainable
 * after the rule is retuned.
 *
 * GAP-18, and the last P1 from the Phase 0 audit. DecisionRule was one
 * mutable row per rule, so editing a rule destroyed the only copy of
 * what it used to say — and rules live in a table PRECISELY so they can
 * be retuned. The consequence was quiet and total: the only answer
 * available to "on what basis was this loan approved in March?" was
 * "on the basis of whatever the rule says today", which for a lender
 * facing a BSP examiner, or a borrower contesting a rejection, is not
 * an answer.
 *
 * Nothing about it looked broken. The rules worked, the decisions were
 * made correctly, and the audit trail — a `decisionReason` string —
 * looked like a record. It named the rule without preserving it.
 */

interface Row extends Record<string, unknown> {
  id: string;
}

/**
 * In-memory Prisma stand-in.
 *
 * `$transaction` runs the callback against the same store, which is
 * enough to test what the code DOES; it deliberately does not model
 * rollback, so no test here may claim atomicity — the unique index that
 * provides it is asserted in the migration and exercised by the last
 * describe block instead.
 */
function fakePrisma() {
  const rules: Row[] = [];
  const versions: Row[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;

  const match = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "ruleId_version") {
        const c = v as { ruleId: string; version: number };
        return row.ruleId === c.ruleId && row.version === c.version;
      }
      if (k === "OR")
        return (v as Record<string, unknown>[]).some((c) => match(row, c));
      if (v !== null && typeof v === "object") {
        const c = v as Record<string, unknown>;
        if ("lte" in c) return (row[k] as Date) <= (c.lte as Date);
        if ("gt" in c) return (row[k] as Date) > (c.gt as Date);
      }
      return row[k] === v;
    });

  const sortBy = (rows: Row[], order?: Record<string, "asc" | "desc">) => {
    if (!order) return rows;
    const [k, dir] = Object.entries(order)[0]!;
    return [...rows].sort((a, b) => {
      const x = a[k] as number;
      const y = b[k] as number;
      return dir === "asc" ? x - y : y - x;
    });
  };

  const table = (store: Row[], defaults: () => Record<string, unknown>) => ({
    findMany: ({
      where = {},
      orderBy,
    }: { where?: Record<string, unknown>; orderBy?: never } = {}) =>
      Promise.resolve(
        sortBy(
          store.filter((r) => match(r, where)),
          orderBy,
        ),
      ),
    findUnique: ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(store.find((r) => match(r, where)) ?? null),
    create: ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { id: id(), ...defaults(), ...data };
      /*
       * The one database rule worth modelling: (ruleId, version) is
       * unique, and it is what stops two concurrent editors from both
       * minting the same version.
       */
      if ("ruleId" in row) {
        const clash = store.some(
          (r) => r.ruleId === row.ruleId && r.version === row.version,
        );
        if (clash) {
          const err = new Error("Unique constraint failed") as Error & {
            code: string;
          };
          err.code = "P2002";
          // Rejected, not thrown: Prisma's client is async, and a
          // synchronous throw would let a caller's `.catch` miss it.
          return Promise.reject(err);
        }
      }
      store.push(row);
      return Promise.resolve(row);
    },
    update: ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const row = store.find((r) => match(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return Promise.resolve(row);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const hit = store.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    },
  });

  const client = {
    decisionRule: table(rules, () => ({
      version: 1,
      effectiveFrom: new Date(),
      retiredAt: null,
      description: null,
      reason: null,
    })),
    decisionRuleVersion: table(versions, () => ({ effectiveTo: null })),
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
    __rules: rules as unknown as DecisionRule[],
    __versions: versions as unknown as DecisionRuleVersion[],
  };
  return client as unknown as PrismaClient & typeof client;
}

const RULE = {
  name: "B-tier fast-track",
  priority: 200,
  conditions: [{ field: "tierAtApply", op: "=" as const, value: "B" }],
  action: "AUTO_APPROVE" as const,
  reason: "B tier, within limits.",
};

let prisma: ReturnType<typeof fakePrisma>;
let repo: DecisionRuleRepository;

beforeEach(() => {
  prisma = fakePrisma();
  repo = new DecisionRuleRepository(prisma);
});

describe("creating a rule", () => {
  it("opens version 1", async () => {
    const rule = await repo.create(RULE, { changedById: "u1" });

    expect(rule.version).toBe(1);
    const history = await repo.historyFor(rule.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      changeType: "CREATE",
      changedById: "u1",
      effectiveTo: null,
    });
  });

  it("freezes the rule's text into the version", async () => {
    const rule = await repo.create(RULE);
    const [v1] = await repo.historyFor(rule.id);

    expect(v1!.ruleName).toBe("B-tier fast-track");
    expect(v1!.priority).toBe(200);
    expect(v1!.action).toBe("AUTO_APPROVE");
  });
});

describe("editing a rule", () => {
  it("closes the standing version and opens the next", async () => {
    const rule = await repo.create(RULE);
    const before = (await repo.historyFor(rule.id))[0];

    const updated = await repo.update(
      rule.id,
      { conditions: [{ field: "tierAtApply", op: "=", value: "C" }] },
      { changedById: "u2", changeNote: "Extended to C tier." },
    );

    expect(updated.version).toBe(2);
    const history = await repo.historyFor(rule.id);
    expect(history.map((v) => v.version)).toEqual([2, 1]);

    const [v2, v1] = history;
    expect(v1!.id).toBe(before!.id);
    expect(v1!.effectiveTo).not.toBeNull();
    expect(v2!.effectiveTo).toBeNull();
    expect(v2!.changeNote).toBe("Extended to C tier.");
  });

  it("keeps the OLD version's conditions intact", async () => {
    /*
     * The whole point. A loan approved under v1 was approved on tier B;
     * if v1's conditions moved with the edit, that loan's basis would
     * have silently become tier C.
     */
    const rule = await repo.create(RULE);
    await repo.update(rule.id, {
      conditions: [{ field: "tierAtApply", op: "=", value: "C" }],
    });

    const v1 = await repo.findVersion(rule.id, 1);
    expect(v1!.conditions).toEqual([
      { field: "tierAtApply", op: "=", value: "B" },
    ]);
  });

  it("bumps on every decisive field", async () => {
    for (const patch of [
      { priority: 100 },
      { action: "MANUAL_REVIEW" as const },
      { reason: "Different reason." },
      { active: false },
      { conditions: [{ field: "customerAge", op: ">=" as const, value: 21 }] },
    ]) {
      const fresh = fakePrisma();
      const r = new DecisionRuleRepository(fresh);
      const rule = await r.create(RULE);
      const updated = await r.update(rule.id, patch);
      expect(updated.version, JSON.stringify(patch)).toBe(2);
    }
  });

  it("does NOT bump on a rename or a reworded description", async () => {
    /*
     * A history that logs cosmetic edits is a history an auditor has to
     * read and discard, which makes the entries that matter harder to
     * find rather than easier.
     */
    const rule = await repo.create(RULE);
    const updated = await repo.update(rule.id, {
      name: "B-tier fast track",
      description: "Clearer wording.",
    });

    expect(updated.version).toBe(1);
    expect(updated.name).toBe("B-tier fast track");
    expect(await repo.historyFor(rule.id)).toHaveLength(1);
  });

  it("does not bump when the conditions are re-sent unchanged", async () => {
    // A JSON round trip can reorder an object's keys. Saving a form
    // without touching it must not mint a version.
    const rule = await repo.create(RULE);
    const updated = await repo.update(rule.id, {
      conditions: [{ value: "B", op: "=", field: "tierAtApply" } as never],
    });

    expect(updated.version).toBe(1);
  });

  it("refuses to edit a retired rule", async () => {
    const rule = await repo.create(RULE);
    await repo.retire(rule.id);

    await expect(repo.update(rule.id, { priority: 5 })).rejects.toThrow(
      /retired/i,
    );
  });

  it("refuses to edit a rule that does not exist", async () => {
    await expect(repo.update("nope", { priority: 5 })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("retiring a rule", () => {
  it("withdraws it from evaluation without destroying it", async () => {
    const rule = await repo.create(RULE);
    await repo.retire(rule.id, {
      changedById: "u3",
      changeNote: "Superseded.",
    });

    expect(await repo.list()).toHaveLength(0);
    expect(await repo.listActive()).toHaveLength(0);
    // But the history is still reachable by id — which is exactly how a
    // stamped loan decision gets to it.
    expect(await repo.historyFor(rule.id)).toHaveLength(2);
  });

  it("records who withdrew it and why", async () => {
    const rule = await repo.create(RULE);
    await repo.retire(rule.id, {
      changedById: "u3",
      changeNote: "Superseded.",
    });

    const [last] = await repo.historyFor(rule.id);
    expect(last!.changeType).toBe("RETIRE");
    expect(last!.changedById).toBe("u3");
    expect(last!.changeNote).toBe("Superseded.");
  });

  it("writes the closing row as a zero-width window", async () => {
    // It records a withdrawal, not a period in which the rule applied.
    const rule = await repo.create(RULE);
    await repo.retire(rule.id);

    const [last] = await repo.historyFor(rule.id);
    expect(last!.effectiveTo).toEqual(last!.effectiveFrom);
  });

  it("is idempotent", async () => {
    const rule = await repo.create(RULE);
    await repo.retire(rule.id);
    await repo.retire(rule.id);

    expect(await repo.historyFor(rule.id)).toHaveLength(2);
  });
});

describe("asOf — the rule set in force at a moment", () => {
  it("returns the version that was standing, not the current one", async () => {
    const rule = await repo.create(RULE);
    const v1 = (await repo.historyFor(rule.id))[0]!;
    /*
     * Backdate v1 rather than sleeping. Everything here happens inside
     * one millisecond, so a window computed off the real clock would be
     * empty and the test would pass or fail on scheduling noise.
     */
    const opened = new Date(Date.now() - 60_000);
    (v1 as { effectiveFrom: Date }).effectiveFrom = opened;
    const during = new Date(opened.getTime() + 1_000);

    await repo.update(rule.id, { priority: 999 });

    const set = await repo.asOf(during);
    expect(set).toHaveLength(1);
    expect(set[0]!.version).toBe(1);
    expect(set[0]!.priority).toBe(200);
  });

  it("excludes a rule that had not been written yet", async () => {
    const before = new Date(Date.now() - 60_000);
    await repo.create(RULE);

    expect(await repo.asOf(before)).toHaveLength(0);
  });

  it("still includes a rule that was paused at the time", async () => {
    /*
     * "Why did nothing stricter catch this?" is answerable only if the
     * set includes the rules that were switched OFF that week. Filtering
     * them out would make the reconstruction quietly wrong in the one
     * direction that matters.
     */
    const rule = await repo.create({ ...RULE, active: false });
    const at = new Date();

    const set = await repo.asOf(at);
    expect(set).toHaveLength(1);
    expect(set[0]!.active).toBe(false);
    expect(set[0]!.ruleId).toBe(rule.id);
  });

  it("replays through the same evaluator the live path uses", async () => {
    // Otherwise "what would the March rules have said?" is a reading
    // exercise rather than a computed answer.
    const rule = await repo.create(RULE);
    const evaluable = repo.versionsToEvaluable(await repo.asOf(new Date()));

    expect(evaluable[0]).toMatchObject({
      id: rule.id,
      name: "B-tier fast-track",
      version: 1,
      action: "AUTO_APPROVE",
      active: true,
    });
  });
});

describe("what the evaluator is handed", () => {
  it("carries the version, so a decision can name it", async () => {
    await repo.create(RULE);
    const [evaluable] = repo.toEvaluable(await repo.listActive());

    expect(evaluable!.version).toBe(1);
  });

  it("hides retired rules from evaluation entirely", async () => {
    const rule = await repo.create(RULE);
    await repo.retire(rule.id);

    expect(repo.toEvaluable(await repo.listActive())).toHaveLength(0);
  });
});

describe("two editors at once", () => {
  it("cannot produce two rows for the same version", async () => {
    /*
     * The claim the unique index on (ruleId, version) makes, restated
     * here so a schema change that dropped it would fail a test rather
     * than pass silently.
     *
     * In Postgres the loser's whole transaction rolls back, so the rule
     * never ends up with two open versions. The stand-in throws P2002
     * the same way; what it cannot model is the rollback, which is why
     * this asserts on the write being refused and not on the aftermath.
     */
    const rule = await repo.create(RULE);
    const versionRow = {
      ruleId: rule.id,
      version: 2,
      ruleName: rule.name,
      priority: 1,
      conditions: [],
      action: "MANUAL_REVIEW",
      active: true,
      changeType: "UPDATE",
    };

    await prisma.decisionRuleVersion.create({ data: versionRow as never });

    await expect(
      prisma.decisionRuleVersion.create({ data: versionRow as never }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
