/**
 * Scoring catalog persistence — the admin-editable credit survey.
 *
 * Reads assemble the shape @loan/credit-scoring wants; writes are
 * ordinary CRUD with the two invariants the domain can't survive
 * without enforced here rather than trusted to the UI:
 *
 *   • Factor and question KEYS are immutable once created. Stored score
 *     breakdowns reference factor keys, and SurveyResponse.answers is
 *     keyed by question key — renaming either orphans history.
 *   • A factor with questions can't be deleted out from under them.
 *
 * Point values are deliberately NOT stored. They're derived from
 * relative weights against a fixed total at read time, so the scale
 * can't drift out of sync with the rows.
 *
 * Every write mints a ScoringCatalogVersion — a snapshot of the WHOLE
 * catalog, not of the row that changed. That is not laziness: points are
 * normalized against a fixed total, so raising one factor's weight
 * lowers every other factor's points. There is no such thing as an edit
 * that touches one factor, and a per-row history would describe a change
 * that did not happen while hiding the one that did.
 */

import type {
  Prisma,
  PrismaClient,
  ScoringCatalogVersion,
  SurveyFactor,
  SurveyQuestionDef,
  SurveyQuestionKind,
} from "@prisma/client";
import {
  DEFAULT_CATALOG,
  type ScoringCatalog,
  type SurveyOption,
  type SurveyQuestion,
} from "@loan/credit-scoring";

export type SurveyFactorInput = {
  key: string;
  label: string;
  weight: number;
  computed?: boolean;
  order?: number;
  active?: boolean;
};

export type SurveyQuestionInput = {
  key: string;
  kind: SurveyQuestionKind;
  label: string;
  help?: string | null;
  category?: string | null;
  order?: number;
  active?: boolean;
  config: unknown;
  factorId: string;
};

export type CatalogFactorRow = SurveyFactor & {
  questions: SurveyQuestionDef[];
};

/** Who changed the scorecard and why. Both optional. */
export interface CatalogChangeMeta {
  changedById?: string;
  changeNote?: string;
}

type ChangeType =
  | "BASELINE"
  | "FACTOR_ADDED"
  | "FACTOR_CHANGED"
  | "FACTOR_REMOVED"
  | "QUESTION_ADDED"
  | "QUESTION_CHANGED"
  | "QUESTION_REMOVED"
  | "REORDERED";

export class ScoringCatalogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Everything, active or not — the builder needs to see both. */
  listFactors(): Promise<CatalogFactorRow[]> {
    return this.prisma.surveyFactor.findMany({
      orderBy: [{ order: "asc" }, { key: "asc" }],
      include: { questions: { orderBy: [{ order: "asc" }, { key: "asc" }] } },
    });
  }

  /**
   * The catalog as the scoring lib consumes it: ACTIVE rows only,
   * mapped into the lib's shapes.
   *
   * Falls back to the shipped catalog when the table is empty. That
   * matters for a tenant provisioned before this feature existed and
   * not yet seeded: scoring keeps working on the built-in questions
   * instead of silently returning zero for everyone.
   */
  async activeCatalog(): Promise<ScoringCatalog> {
    const factors = await this.prisma.surveyFactor.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { key: "asc" }],
      include: {
        questions: {
          where: { active: true },
          orderBy: [{ order: "asc" }, { key: "asc" }],
        },
      },
    });
    if (factors.length === 0) return DEFAULT_CATALOG;

    const questions: SurveyQuestion[] = [];
    for (const f of factors) {
      for (const q of f.questions) {
        const built = toLibQuestion(q, f.key);
        if (built) questions.push(built);
      }
    }
    return {
      factors: factors.map((f) => ({
        id: f.key,
        label: f.label,
        weight: f.weight,
        computed: f.computed,
      })),
      questions,
    };
  }

  createFactor(
    input: SurveyFactorInput,
    meta: CatalogChangeMeta = {},
  ): Promise<SurveyFactor> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyFactor.create({
        data: {
          key: input.key,
          label: input.label,
          weight: input.weight,
          computed: input.computed ?? false,
          order: input.order ?? 0,
          active: input.active ?? true,
        },
      });
      await this.mint(tx, "FACTOR_ADDED", `added factor "${row.key}"`, meta);
      return row;
    });
  }

  /** `key` is intentionally absent — see the class comment. */
  updateFactor(
    id: string,
    input: Partial<Omit<SurveyFactorInput, "key">>,
    meta: CatalogChangeMeta = {},
  ): Promise<SurveyFactor> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyFactor.update({ where: { id }, data: input });
      /*
       * The summary names the WEIGHT specifically when it moved, because
       * that is the edit that silently restates every other factor's
       * points. A label change is worth recording and worth reading
       * differently.
       */
      const what =
        input.weight !== undefined
          ? `weight changed on "${row.key}"`
          : `changed factor "${row.key}"`;
      await this.mint(tx, "FACTOR_CHANGED", what, meta);
      return row;
    });
  }

  /**
   * Refuses while questions still hang off the factor. The FK cascades,
   * so without this check deleting a factor would silently take its
   * questions — and every answer key they own — with it.
   */
  async deleteFactor(
    id: string,
    meta: CatalogChangeMeta = {},
  ): Promise<{ ok: true } | { ok: false; questionCount: number }> {
    const questionCount = await this.prisma.surveyQuestionDef.count({
      where: { factorId: id },
    });
    if (questionCount > 0) return { ok: false, questionCount };
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyFactor.delete({ where: { id } });
      await this.mint(
        tx,
        "FACTOR_REMOVED",
        `removed factor "${row.key}"`,
        meta,
      );
    });
    return { ok: true };
  }

  createQuestion(
    input: SurveyQuestionInput,
    meta: CatalogChangeMeta = {},
  ): Promise<SurveyQuestionDef> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyQuestionDef.create({
        data: {
          key: input.key,
          kind: input.kind,
          label: input.label,
          help: input.help ?? null,
          category: input.category ?? null,
          order: input.order ?? 0,
          active: input.active ?? true,
          config: input.config as never,
          factorId: input.factorId,
        },
      });
      await this.mint(
        tx,
        "QUESTION_ADDED",
        `added question "${row.key}"`,
        meta,
      );
      return row;
    });
  }

  /** One row by id — the update path reads it to validate the merged
   *  kind/config pair before writing. Null when the id is unknown. */
  findQuestion(id: string): Promise<SurveyQuestionDef | null> {
    return this.prisma.surveyQuestionDef.findUnique({ where: { id } });
  }

  updateQuestion(
    id: string,
    input: Partial<Omit<SurveyQuestionInput, "key">>,
    meta: CatalogChangeMeta = {},
  ): Promise<SurveyQuestionDef> {
    const { config, ...rest } = input;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyQuestionDef.update({
        where: { id },
        data: {
          ...rest,
          ...(config !== undefined ? { config: config as never } : {}),
        },
      });
      /*
       * A config edit is the one that matters most and shows least. It
       * is what moves a CHOICE option's weight, and once it lands, "why
       * did answering X score 0.6?" has no answer from the stored
       * breakdown alone — which records the factor, not the question.
       */
      const what =
        config !== undefined
          ? `answer weights changed on "${row.key}"`
          : `changed question "${row.key}"`;
      await this.mint(tx, "QUESTION_CHANGED", what, meta);
      return row;
    });
  }

  async deleteQuestion(
    id: string,
    meta: CatalogChangeMeta = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.surveyQuestionDef.delete({ where: { id } });
      await this.mint(
        tx,
        "QUESTION_REMOVED",
        `removed question "${row.key}"`,
        meta,
      );
    });
  }

  /**
   * Persist a new ordering in one transaction.
   *
   * Order changes nothing about a score — points come from weights, and
   * every active question is evaluated regardless. It is still versioned,
   * because the order is what the BORROWER saw, and "the questions were
   * asked in this sequence" is part of what a survey response means.
   */
  async reorderQuestions(
    ids: string[],
    meta: CatalogChangeMeta = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx.surveyQuestionDef.update({
          where: { id },
          data: { order: index },
        });
      }
      await this.mint(tx, "REORDERED", "reordered questions", meta);
    });
  }

  async reorderFactors(
    ids: string[],
    meta: CatalogChangeMeta = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx.surveyFactor.update({ where: { id }, data: { order: index } });
      }
      await this.mint(tx, "REORDERED", "reordered factors", meta);
    });
  }

  // ── Versioning ──────────────────────────────────────────────────────

  /** The scorecard in force now, or null before the baseline is minted. */
  currentVersion(): Promise<ScoringCatalogVersion | null> {
    return this.prisma.scoringCatalogVersion.findFirst({
      where: { effectiveTo: null },
      orderBy: { version: "desc" },
    });
  }

  /** Newest first. */
  history(): Promise<ScoringCatalogVersion[]> {
    return this.prisma.scoringCatalogVersion.findMany({
      orderBy: { version: "desc" },
    });
  }

  findVersion(version: number): Promise<ScoringCatalogVersion | null> {
    return this.prisma.scoringCatalogVersion.findUnique({ where: { version } });
  }

  /**
   * The scorecard as it stood at a moment — the half-open window
   * [effectiveFrom, effectiveTo), same convention as decision rules.
   */
  versionAt(at: Date): Promise<ScoringCatalogVersion | null> {
    return this.prisma.scoringCatalogVersion.findFirst({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { version: "desc" },
    });
  }

  /**
   * Make a stored snapshot runnable.
   *
   * The whole reason the snapshot is the lib's own shape: rescoring a
   * borrower under the scorecard that scored them is a function call,
   * not a reconstruction. A reconstruction would be a second mapping to
   * keep true, and the second copy is the one that goes stale.
   */
  static toCatalog(v: ScoringCatalogVersion): ScoringCatalog {
    return v.snapshot as unknown as ScoringCatalog;
  }

  /**
   * Mint version 1 if the history is empty. Called at boot, beside the
   * other reconcile steps.
   *
   * Not done in the migration: the snapshot has to be the shape
   * @loan/credit-scoring consumes, INCLUDING the DEFAULT_CATALOG
   * fallback for a tenant whose tables are still empty. Reproducing that
   * mapping in SQL would duplicate it, and duplicated mappings drift.
   */
  async ensureBaseline(): Promise<{ created: boolean; version: number }> {
    const existing = await this.currentVersion();
    if (existing) return { created: false, version: existing.version };
    await this.prisma.$transaction(async (tx) => {
      await this.mint(tx, "BASELINE", "the scorecard as first recorded", {});
    });
    return { created: true, version: 1 };
  }

  /**
   * Close the standing version and open the next, holding a snapshot of
   * the catalog as it stands AFTER the caller's write.
   *
   * Runs inside the caller's transaction, so a mutation that fails takes
   * its version with it — a history entry describing a change that never
   * landed is worse than no entry.
   *
   * The unique index on `version` is what makes two concurrent editors
   * safe: both read version N, both try to write N + 1, and the loser's
   * whole transaction rolls back rather than leaving two rows claiming
   * to be current.
   */
  private async mint(
    tx: Prisma.TransactionClient,
    changeType: ChangeType,
    summary: string,
    meta: CatalogChangeMeta,
  ): Promise<void> {
    const snapshot = await catalogFromTx(tx);
    const now = new Date();

    const latest = await tx.scoringCatalogVersion.findFirst({
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const next = (latest?.version ?? 0) + 1;

    await tx.scoringCatalogVersion.updateMany({
      where: { effectiveTo: null },
      data: { effectiveTo: now },
    });
    await tx.scoringCatalogVersion.create({
      data: {
        version: next,
        snapshot: snapshot as never,
        factorCount: snapshot.factors.length,
        questionCount: snapshot.questions.length,
        effectiveFrom: now,
        changeType,
        changeSummary: summary,
        changeNote: meta.changeNote,
        changedById: meta.changedById,
      },
    });
  }
}

/**
 * The active catalog, read through a transaction client.
 *
 * Same query as `activeCatalog`, fallback included, but bound to the
 * caller's transaction so the snapshot sees the write that just happened
 * rather than the state before it.
 */
async function catalogFromTx(
  tx: Prisma.TransactionClient,
): Promise<ScoringCatalog> {
  const factors = await tx.surveyFactor.findMany({
    where: { active: true },
    orderBy: [{ order: "asc" }, { key: "asc" }],
    include: {
      questions: {
        where: { active: true },
        orderBy: [{ order: "asc" }, { key: "asc" }],
      },
    },
  });
  if (factors.length === 0) return DEFAULT_CATALOG;

  const questions: SurveyQuestion[] = [];
  for (const f of factors) {
    for (const q of f.questions) {
      const built = toLibQuestion(q, f.key);
      if (built) questions.push(built);
    }
  }
  return {
    factors: factors.map((f) => ({
      id: f.key,
      label: f.label,
      weight: f.weight,
      computed: f.computed,
    })),
    questions,
  };
}

/**
 * DB row → the lib's discriminated question union.
 *
 * Returns null for a row whose config doesn't match its kind rather
 * than throwing: a malformed row should cost that one question, not
 * every score in the tenant. The API validates on write, so reaching
 * this means hand-edited data.
 */
function toLibQuestion(
  q: SurveyQuestionDef,
  factorId: string,
): SurveyQuestion | null {
  const cfg = (q.config ?? {}) as Record<string, unknown>;
  const base = {
    id: q.key,
    label: q.label,
    help: q.help ?? undefined,
    factorId,
  };
  switch (q.kind) {
    case "CHOICE": {
      const options = cfg.options;
      if (!Array.isArray(options) || options.length === 0) return null;
      return {
        kind: "choice",
        ...base,
        options: options as SurveyOption[],
      };
    }
    case "NUMBER": {
      if (typeof cfg.min !== "number" || typeof cfg.max !== "number") {
        return null;
      }
      return {
        kind: "number",
        ...base,
        min: cfg.min,
        max: cfg.max,
        step: typeof cfg.step === "number" ? cfg.step : undefined,
        inverted: cfg.inverted === true,
      };
    }
    case "BOOLEAN": {
      if (typeof cfg.weightWhenTrue !== "number") return null;
      return {
        kind: "boolean",
        ...base,
        weightWhenTrue: cfg.weightWhenTrue,
      };
    }
  }
}

/**
 * Seed the catalog from the shipped one. Idempotent by key, and it
 * never overwrites an existing row — an admin's tuning must survive a
 * reseed, which is exactly what makes reseeding safe to run.
 */
export async function seedScoringCatalog(
  prisma: PrismaClient,
): Promise<{ factors: number; questions: number }> {
  let factors = 0;
  let questions = 0;

  for (const [index, f] of DEFAULT_CATALOG.factors.entries()) {
    const existing = await prisma.surveyFactor.findUnique({
      where: { key: f.id },
    });
    if (existing) continue;
    await prisma.surveyFactor.create({
      data: {
        key: f.id,
        label: f.label,
        weight: f.weight,
        computed: f.computed ?? false,
        order: index,
      },
    });
    factors += 1;
  }

  const byKey = new Map(
    (await prisma.surveyFactor.findMany()).map((f) => [f.key, f.id]),
  );

  for (const [index, q] of DEFAULT_CATALOG.questions.entries()) {
    const existing = await prisma.surveyQuestionDef.findUnique({
      where: { key: q.id },
    });
    if (existing) continue;
    const factorId = byKey.get(q.factorId);
    if (!factorId) continue;
    await prisma.surveyQuestionDef.create({
      data: {
        key: q.id,
        kind:
          q.kind === "choice"
            ? "CHOICE"
            : q.kind === "number"
              ? "NUMBER"
              : "BOOLEAN",
        label: q.label,
        help: q.help ?? null,
        order: index,
        factorId,
        config:
          q.kind === "choice"
            ? ({ options: q.options } as never)
            : q.kind === "number"
              ? ({
                  min: q.min,
                  max: q.max,
                  step: q.step,
                  inverted: q.inverted ?? false,
                } as never)
              : ({ weightWhenTrue: q.weightWhenTrue } as never),
      },
    });
    questions += 1;
  }

  return { factors, questions };
}
