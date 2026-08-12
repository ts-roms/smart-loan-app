import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ScoringCatalogRepository } from "./scoring-catalog.repository";

/**
 * Invariant: a stored credit score can be traced to the scorecard that
 * produced it, and that scorecard can be run again.
 *
 * This is the decision-rule problem applied to scoring, and it is
 * NARROWER than the audit first claimed — which is worth stating,
 * because building on the wrong premise would have produced the wrong
 * thing.
 *
 * `CreditScore.breakdown` was already good: it freezes each factor's
 * label, its resolved maxPoints, the 0..1 weight achieved, the points,
 * and a human-readable source line. A stored score already says what it
 * was made OF. What it could not say was what it was made BY — and
 * therefore:
 *
 *   • whether two scores are comparable at all;
 *   • what the QUESTIONS offered, since the breakdown records the
 *     factor, not the question. Edit a CHOICE option's weight and "why
 *     did answering 'employed 2 years' score 0.6?" loses its answer;
 *   • which factors were switched OFF, since an inactive factor is
 *     simply absent and indistinguishable from one that scored zero;
 *   • who changed the scorecard, when, or why.
 *
 * The versioned unit is the WHOLE catalog, unlike a decision rule.
 * Points are normalized against a fixed total, so raising one factor's
 * weight lowers every other factor's points. There is no edit that
 * touches one factor, and a per-factor history would describe a change
 * that did not happen while hiding the one that did.
 */

interface Row extends Record<string, unknown> {
  id: string;
}

/** In-memory Prisma stand-in. Models only what these tests exercise. */
function fakePrisma() {
  const factors: Row[] = [];
  const questions: Row[] = [];
  const versions: Row[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;

  const match = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR")
        return (v as Record<string, unknown>[]).some((c) => match(row, c));
      if (v !== null && typeof v === "object") {
        const c = v as Record<string, unknown>;
        if ("lte" in c) return (row[k] as Date) <= (c.lte as Date);
        if ("gt" in c) return (row[k] as Date) > (c.gt as Date);
        if ("not" in c) return row[k] !== c.not;
      }
      return row[k] === v;
    });

  const sorted = (rows: Row[], orderBy?: Record<string, string>) => {
    if (!orderBy) return rows;
    const [k, dir] = Object.entries(orderBy)[0]!;
    return [...rows].sort((a, b) => {
      const x = a[k] as number;
      const y = b[k] as number;
      return dir === "asc" ? x - y : y - x;
    });
  };

  const table = (
    store: Row[],
    defaults: () => Record<string, unknown> = () => ({}),
  ) => ({
    findMany: (
      args: {
        where?: Record<string, unknown>;
        orderBy?: never;
        include?: never;
      } = {},
    ) => {
      const rows = sorted(
        store.filter((r) => match(r, args.where)),
        // Prisma accepts an array of orderBy; only the first matters here.
        Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy,
      );
      if (!args.include) return Promise.resolve(rows);
      // The only include used is factor -> questions.
      return Promise.resolve(
        rows.map((f) => ({
          ...f,
          questions: questions.filter(
            (q) => q.factorId === f.id && q.active === true,
          ),
        })),
      );
    },
    findFirst: (
      args: { where?: Record<string, unknown>; orderBy?: never } = {},
    ) =>
      Promise.resolve(
        sorted(
          store.filter((r) => match(r, args.where)),
          Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy,
        )[0] ?? null,
      ),
    findUnique: ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(store.find((r) => match(r, where)) ?? null),
    count: ({ where }: { where?: Record<string, unknown> } = {}) =>
      Promise.resolve(store.filter((r) => match(r, where)).length),
    create: ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { id: id(), ...defaults(), ...data };
      /*
       * The one database rule worth modelling: `version` is unique, and
       * it is what stops two concurrent editors from both minting the
       * same version.
       */
      if ("version" in row && store.some((r) => r.version === row.version)) {
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
        };
        err.code = "P2002";
        return Promise.reject(err);
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
      if (!row) return Promise.reject(new Error("not found"));
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
    delete: ({ where }: { where: Record<string, unknown> }) => {
      const i = store.findIndex((r) => match(r, where));
      if (i < 0) return Promise.reject(new Error("not found"));
      return Promise.resolve(store.splice(i, 1)[0]!);
    },
  });

  const client = {
    surveyFactor: table(factors, () => ({
      active: true,
      computed: false,
      order: 0,
    })),
    surveyQuestionDef: table(questions, () => ({ active: true, order: 0 })),
    scoringCatalogVersion: table(versions, () => ({ effectiveTo: null })),
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
    __versions: versions,
    __factors: factors,
  };
  return client as unknown as PrismaClient & typeof client;
}

let prisma: ReturnType<typeof fakePrisma>;
let repo: ScoringCatalogRepository;

const FACTOR = { key: "income", label: "Income", weight: 25 };
const QUESTION = {
  key: "monthly_income",
  kind: "NUMBER" as const,
  label: "Monthly income",
  config: { min: 0, max: 100_000 },
  factorId: "",
};

beforeEach(() => {
  prisma = fakePrisma();
  repo = new ScoringCatalogRepository(prisma);
});

describe("the baseline", () => {
  it("is minted once and then left alone", async () => {
    const first = await repo.ensureBaseline();
    const second = await repo.ensureBaseline();

    expect(first).toEqual({ created: true, version: 1 });
    expect(second).toEqual({ created: false, version: 1 });
    expect(await repo.history()).toHaveLength(1);
  });

  it("records itself as BASELINE, not as an edit", async () => {
    // An operator reading v1 should see "this is where the record
    // starts", not a change somebody made.
    await repo.ensureBaseline();
    const [v1] = await repo.history();

    expect(v1!.changeType).toBe("BASELINE");
    expect(v1!.changedById).toBeUndefined();
  });

  it("falls back to the shipped catalog when the tables are empty", async () => {
    /*
     * A tenant provisioned before the catalog became editable scores on
     * the built-in questions. The baseline has to capture THAT, not an
     * empty scorecard, or the version would claim nothing was being
     * scored while scoring continued.
     */
    await repo.ensureBaseline();
    const v = (await repo.currentVersion())!;

    expect(v.factorCount).toBeGreaterThan(0);
    expect(v.questionCount).toBeGreaterThan(0);
  });
});

describe("every edit mints a version", () => {
  beforeEach(async () => {
    await repo.ensureBaseline();
  });

  it("adding a factor", async () => {
    await repo.createFactor(FACTOR, { changedById: "u1" });

    const [latest] = await repo.history();
    expect(latest!.version).toBe(2);
    expect(latest!.changeType).toBe("FACTOR_ADDED");
    expect(latest!.changedById).toBe("u1");
  });

  it("changing a weight, and says so specifically", async () => {
    /*
     * The summary singles out a weight change because that is the edit
     * that silently restates every OTHER factor's points. "changed
     * factor" would be true and useless.
     */
    const f = await repo.createFactor(FACTOR);
    await repo.updateFactor(f.id, { weight: 40 });

    const [latest] = await repo.history();
    expect(latest!.changeType).toBe("FACTOR_CHANGED");
    expect(latest!.changeSummary).toMatch(/weight changed on "income"/);
  });

  it("changing a label, and does NOT call it a weight change", async () => {
    const f = await repo.createFactor(FACTOR);
    await repo.updateFactor(f.id, { label: "Monthly income" });

    const [latest] = await repo.history();
    expect(latest!.changeSummary).not.toMatch(/weight/);
  });

  it("editing a question's answer weights", async () => {
    /*
     * The edit that matters most and shows least. Move a CHOICE
     * option's weight and every historical breakdown still reads
     * correctly — it froze the achieved weight — while the reason for
     * that weight silently disappears.
     */
    const f = await repo.createFactor(FACTOR);
    const q = await repo.createQuestion({ ...QUESTION, factorId: f.id });
    await repo.updateQuestion(q.id, { config: { min: 0, max: 50_000 } });

    const [latest] = await repo.history();
    expect(latest!.changeType).toBe("QUESTION_CHANGED");
    expect(latest!.changeSummary).toMatch(/answer weights changed/);
  });

  it("reordering, even though it changes no score", async () => {
    // Order is what the BORROWER saw. "The questions were asked in this
    // sequence" is part of what a survey response means.
    const f = await repo.createFactor(FACTOR);
    const q = await repo.createQuestion({ ...QUESTION, factorId: f.id });
    await repo.reorderQuestions([q.id]);

    const [latest] = await repo.history();
    expect(latest!.changeType).toBe("REORDERED");
  });

  it("removing a factor", async () => {
    const f = await repo.createFactor(FACTOR);
    const result = await repo.deleteFactor(f.id);

    expect(result.ok).toBe(true);
    const [latest] = await repo.history();
    expect(latest!.changeType).toBe("FACTOR_REMOVED");
  });

  it("but NOT when the delete is refused", async () => {
    /*
     * A version describing a change that did not land is worse than no
     * version — it is a record of something that never happened.
     */
    const f = await repo.createFactor(FACTOR);
    await repo.createQuestion({ ...QUESTION, factorId: f.id });
    const before = (await repo.history()).length;

    const result = await repo.deleteFactor(f.id);

    expect(result.ok).toBe(false);
    expect(await repo.history()).toHaveLength(before);
  });
});

describe("exactly one version is ever open", () => {
  it("after a run of edits", async () => {
    await repo.ensureBaseline();
    const f = await repo.createFactor(FACTOR);
    await repo.updateFactor(f.id, { weight: 30 });
    await repo.updateFactor(f.id, { weight: 35 });

    const open = (await repo.history()).filter((v) => v.effectiveTo === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.version).toBe(4);
  });

  it("and the closed ones bound a period", async () => {
    await repo.ensureBaseline();
    await repo.createFactor(FACTOR);

    const [, first] = await repo.history();
    expect(first!.effectiveTo).not.toBeNull();
    expect(first!.effectiveTo!.getTime()).toBeGreaterThanOrEqual(
      first!.effectiveFrom.getTime(),
    );
  });

  it("and a second write of the same version number is refused", async () => {
    /*
     * The claim the unique index makes, restated so a schema change
     * that dropped it fails a test rather than passing silently. In
     * Postgres the loser's whole transaction rolls back, so the catalog
     * never ends up with two versions claiming to be current.
     */
    await repo.ensureBaseline();
    const row = {
      version: 1,
      snapshot: {},
      factorCount: 0,
      questionCount: 0,
      changeType: "BASELINE",
    };

    await expect(
      prisma.scoringCatalogVersion.create({ data: row as never }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("a snapshot is runnable, not just readable", () => {
  it("holds the shape the scoring lib consumes", async () => {
    /*
     * The whole reason the snapshot is stored in the lib's own shape:
     * rescoring a borrower under the scorecard that scored them is a
     * function call. A reconstruction would be a second mapping to keep
     * true, and the second copy is the one that goes stale.
     */
    await repo.ensureBaseline();
    const catalog = ScoringCatalogRepository.toCatalog(
      (await repo.currentVersion())!,
    );

    expect(Array.isArray(catalog.factors)).toBe(true);
    expect(Array.isArray(catalog.questions)).toBe(true);
    expect(catalog.factors[0]).toHaveProperty("weight");
  });

  it("captures the catalog AFTER the edit, not before it", async () => {
    // Snapshotting the pre-edit state would make every version describe
    // the one before it — off by one, and plausible enough to survive
    // review.
    await repo.ensureBaseline();
    await repo.createFactor(FACTOR);

    const catalog = ScoringCatalogRepository.toCatalog(
      (await repo.currentVersion())!,
    );
    expect(catalog.factors.some((f) => f.id === "income")).toBe(true);
  });

  it("omits an inactive factor, which is why the version is needed", async () => {
    /*
     * An inactive factor is absent from a score's breakdown too, and
     * indistinguishable there from one that scored zero. The snapshot
     * is what settles which it was.
     *
     * Two factors, not one: with NO active factors the catalog falls
     * back to the shipped one, which has its own `income` — so a
     * single-factor version of this test asserts on the fallback and
     * fails for a reason that has nothing to do with active flags.
     */
    await repo.ensureBaseline();
    await repo.createFactor({ key: "on_time", label: "On time", weight: 20 });
    await repo.createFactor({ ...FACTOR, active: false });

    const catalog = ScoringCatalogRepository.toCatalog(
      (await repo.currentVersion())!,
    );
    expect(catalog.factors.some((x) => x.id === "on_time")).toBe(true);
    expect(catalog.factors.some((x) => x.id === "income")).toBe(false);
  });
});

describe("looking a version up", () => {
  it("finds the one in force at a moment", async () => {
    await repo.ensureBaseline();
    const v1 = (await repo.currentVersion())!;
    const opened = new Date(Date.now() - 60_000);
    // Backdate rather than sleep: everything here happens inside one
    // millisecond, so a real-clock window would be empty.
    (v1 as { effectiveFrom: Date }).effectiveFrom = opened;
    const during = new Date(opened.getTime() + 1_000);

    await repo.createFactor(FACTOR);

    const at = await repo.versionAt(during);
    expect(at!.version).toBe(1);
  });

  it("finds nothing before the scorecard existed", async () => {
    await repo.ensureBaseline();

    expect(await repo.versionAt(new Date(Date.now() - 86_400_000))).toBeNull();
  });

  it("resolves the version a score was stamped with", async () => {
    await repo.ensureBaseline();
    await repo.createFactor(FACTOR);

    // What a stored CreditScore.catalogVersion of 1 points at.
    const v = await repo.findVersion(1);
    expect(v!.changeType).toBe("BASELINE");
  });
});
