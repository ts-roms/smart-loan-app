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
 */

import type {
  PrismaClient,
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

  createFactor(input: SurveyFactorInput): Promise<SurveyFactor> {
    return this.prisma.surveyFactor.create({
      data: {
        key: input.key,
        label: input.label,
        weight: input.weight,
        computed: input.computed ?? false,
        order: input.order ?? 0,
        active: input.active ?? true,
      },
    });
  }

  /** `key` is intentionally absent — see the class comment. */
  updateFactor(
    id: string,
    input: Partial<Omit<SurveyFactorInput, "key">>,
  ): Promise<SurveyFactor> {
    return this.prisma.surveyFactor.update({ where: { id }, data: input });
  }

  /**
   * Refuses while questions still hang off the factor. The FK cascades,
   * so without this check deleting a factor would silently take its
   * questions — and every answer key they own — with it.
   */
  async deleteFactor(
    id: string,
  ): Promise<{ ok: true } | { ok: false; questionCount: number }> {
    const questionCount = await this.prisma.surveyQuestionDef.count({
      where: { factorId: id },
    });
    if (questionCount > 0) return { ok: false, questionCount };
    await this.prisma.surveyFactor.delete({ where: { id } });
    return { ok: true };
  }

  createQuestion(input: SurveyQuestionInput): Promise<SurveyQuestionDef> {
    return this.prisma.surveyQuestionDef.create({
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
  }

  updateQuestion(
    id: string,
    input: Partial<Omit<SurveyQuestionInput, "key">>,
  ): Promise<SurveyQuestionDef> {
    const { config, ...rest } = input;
    return this.prisma.surveyQuestionDef.update({
      where: { id },
      data: {
        ...rest,
        ...(config !== undefined ? { config: config as never } : {}),
      },
    });
  }

  async deleteQuestion(id: string): Promise<void> {
    await this.prisma.surveyQuestionDef.delete({ where: { id } });
  }

  /** Persist a new ordering in one transaction. */
  async reorderQuestions(ids: string[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.surveyQuestionDef.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );
  }

  async reorderFactors(ids: string[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.surveyFactor.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );
  }
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
