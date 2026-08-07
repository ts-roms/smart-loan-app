import { resolveFactorPoints, TOTAL_RAW_POINTS } from "@loan/credit-scoring";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  factorCreateSchema,
  factorUpdateSchema,
  questionCreateSchema,
  questionUpdateSchema,
  reorderSchema,
  validateKindConfig,
} from "./catalog.schemas";

/**
 * HTTP adapter for the scoring catalog — the admin-editable credit
 * survey. Stateless singleton; reads the per-request repository off
 * `req.scoringServices`.
 *
 * The list response carries each factor's RESOLVED points alongside its
 * weight. The builder needs to show what a weight is actually worth,
 * and deriving it client-side would mean a second implementation of the
 * apportionment — which is exactly how the UI and the scorer would come
 * to disagree about what a factor is worth.
 */
export class ScoringCatalogController {
  list = async (req: FastifyRequest) => {
    const repo = req.scoringServices!.catalog;
    const factors = await repo.listFactors();
    // Resolve against ACTIVE factors only: an inactive factor doesn't
    // score, so it mustn't dilute the points of the ones that do.
    const resolved = resolveFactorPoints(
      factors
        .filter((f) => f.active)
        .map((f) => ({ id: f.key, label: f.label, weight: f.weight })),
    );
    const pointsByKey = new Map(resolved.map((r) => [r.id, r.maxPoints]));

    return {
      totalPoints: TOTAL_RAW_POINTS,
      factors: factors.map((f) => ({
        id: f.id,
        key: f.key,
        label: f.label,
        weight: f.weight,
        computed: f.computed,
        order: f.order,
        active: f.active,
        /** Null when inactive — it contributes nothing to a score. */
        maxPoints: f.active ? (pointsByKey.get(f.key) ?? 0) : null,
        questions: f.questions.map((q) => ({
          id: q.id,
          key: q.key,
          kind: q.kind,
          label: q.label,
          help: q.help,
          category: q.category,
          order: q.order,
          active: q.active,
          config: q.config,
        })),
      })),
    };
  };

  createFactor = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = factorCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const created = await req.scoringServices!.catalog.createFactor(
        parsed.data,
      );
      return reply.code(201).send(created);
    } catch {
      // Unique violation on `key` is the only realistic failure here.
      return reply.code(409).send({
        error: "DuplicateKey",
        message: `A factor with key "${parsed.data.key}" already exists.`,
      });
    }
  };

  updateFactor = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = factorUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.scoringServices!.catalog.updateFactor(
        req.params.id,
        parsed.data,
      );
    } catch {
      return reply.code(404).send({ error: "NotFound" });
    }
  };

  deleteFactor = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.scoringServices!.catalog.deleteFactor(
      req.params.id,
    );
    if (!result.ok) {
      // The FK cascades, so deleting a factor would silently take its
      // questions — and every answer key they own — with it.
      return reply.code(409).send({
        error: "FactorHasQuestions",
        message: `Move or delete this factor's ${result.questionCount} question(s) first.`,
        questionCount: result.questionCount,
      });
    }
    return reply.code(204).send();
  };

  createQuestion = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = questionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const input = parsed.data;
    try {
      // `config` is spelled out rather than spread: zod types an
      // unknown as an OPTIONAL property, and the repository requires it.
      const created = await req.scoringServices!.catalog.createQuestion({
        ...input,
        config: input.config,
      });
      return reply.code(201).send(created);
    } catch {
      return reply.code(409).send({
        error: "DuplicateKey",
        message: `A question with key "${input.key}" already exists.`,
      });
    }
  };

  updateQuestion = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = questionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const patch = parsed.data;

    /*
     * The schema's kind/config cross-check can only see the fields it
     * was sent, so a patch carrying just one of the pair used to slip
     * through unvalidated: `{ config: <garbage> }` stored arbitrary
     * config, and `{ kind }` alone left the old kind's config behind.
     * Either way the row then fails toLibQuestion's shape check and the
     * question silently vanishes from the survey — borrowers just stop
     * being asked it. Validate the EFFECTIVE pair (request merged over
     * the stored row) whenever either half changes.
     */
    if (patch.kind !== undefined || patch.config !== undefined) {
      const existing = await req.scoringServices!.catalog.findQuestion(
        req.params.id,
      );
      if (!existing) return reply.code(404).send({ error: "NotFound" });
      const issues = validateKindConfig(
        patch.kind ?? existing.kind,
        patch.config !== undefined ? patch.config : existing.config,
      );
      if (issues) {
        return reply.code(400).send({ error: "ValidationError", issues });
      }
    }

    try {
      return await req.scoringServices!.catalog.updateQuestion(
        req.params.id,
        patch,
      );
    } catch {
      return reply.code(404).send({ error: "NotFound" });
    }
  };

  deleteQuestion = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    try {
      await req.scoringServices!.catalog.deleteQuestion(req.params.id);
      return reply.code(204).send();
    } catch {
      return reply.code(404).send({ error: "NotFound" });
    }
  };

  reorderFactors = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    await req.scoringServices!.catalog.reorderFactors(parsed.data.ids);
    return reply.code(204).send();
  };

  reorderQuestions = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    await req.scoringServices!.catalog.reorderQuestions(parsed.data.ids);
    return reply.code(204).send();
  };
}
