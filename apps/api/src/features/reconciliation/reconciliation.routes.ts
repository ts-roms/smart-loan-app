/**
 * Bank reconciliation routes.
 *
 * All routes require `accounting.read` to view and `accounting.post_journal`
 * to mutate — reconciliation is essentially journal-adjacent work.
 *
 * Phase 2: per-request repo wiring against `req.tenantCtx.prisma`.
 */

import {
  AuditLogRepository,
  BankLineAlreadyMatchedError,
  BankReconciliationRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";

import {
  autoMatchResponseSchema,
  candidateListResponseSchema,
  lineIdParamSchema,
  lineResponseSchema,
  manualMatchSchema,
  statementDetailResponseSchema,
  statementIdParamSchema,
  statementListResponseSchema,
  statementResponseSchema,
  statementSchema,
  summaryResponseSchema,
} from "./schemas";
import { auditFor } from "../../lib/audit-context";

const TAGS = ["reconciliation"];

declare module "fastify" {
  interface FastifyRequest {
    reconciliationCtx?: {
      repo: BankReconciliationRepository;
      audit: AuditLogRepository;
    };
  }
}

export async function reconciliationRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed statement got a 400 describing the import schema
   * instead of a 401. See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Bank reconciliation is a PROFESSIONAL-tier feature. The gate reads
  // req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("accounting.reconciliation"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.reconciliationCtx = {
      repo: new BankReconciliationRepository(prisma),
      audit: auditFor(req, prisma),
    };
  });

  app.get(
    "/statements",
    {
      preHandler: app.requirePermission("accounting.read"),
      schema: routeSchema({
        summary:
          "Imported bank statements, most recent period first. Headers " +
          "only — fetch one by id for its lines.",
        tags: TAGS,
        permission: "accounting.read",
        response: statementListResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.reconciliationCtx!.repo.list(),
  );

  app.get<{ Params: { id: string } }>(
    "/statements/:id",
    {
      preHandler: app.requirePermission("accounting.read"),
      schema: routeSchema({
        summary: "One statement with every imported line, oldest first.",
        tags: TAGS,
        permission: "accounting.read",
        params: statementIdParamSchema,
        response: statementDetailResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    async (req, reply) => {
      const s = await req.reconciliationCtx!.repo.findById(req.params.id);
      if (!s) return reply.code(404).send({ error: "NotFound" });
      return s;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/statements/:id/summary",
    {
      preHandler: app.requirePermission("accounting.read"),
      schema: routeSchema({
        summary:
          "Matched/unmatched counts and amounts for one statement — the " +
          "reconciliation dashboard's counters.",
        tags: TAGS,
        permission: "accounting.read",
        params: statementIdParamSchema,
        response: summaryResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.reconciliationCtx!.repo.summary(req.params.id),
  );

  app.post(
    "/statements",
    {
      preHandler: app.requirePermission("accounting.post_journal"),
      schema: routeSchema({
        summary:
          "Import a bank statement and its lines in one call. Answers the " +
          "statement header; the lines are not echoed back. NOT " +
          "idempotent — re-importing duplicates the whole statement.",
        tags: TAGS,
        permission: "accounting.post_journal",
        /*
         * No `idempotency`. There is no key and no natural-key dedupe
         * on (account, period) or line hash, so posting the same file
         * twice creates a second statement and a second full set of
         * lines. The `bank_line_match_unique` index does NOT help here:
         * it stops two lines claiming the same payment, which is match
         * exclusivity, not import idempotency. Named in the summary
         * because re-uploading a statement is a normal thing for an
         * operator to do when they are unsure whether the first one
         * landed.
         */
        body: statementSchema,
        response: statementResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    async (req, reply) => {
      const { repo, audit } = req.reconciliationCtx!;
      const parsed = statementSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const statement = await repo.create(
        {
          label: parsed.data.label,
          bankAccount: parsed.data.bankAccount,
          periodStart: new Date(parsed.data.periodStart),
          periodEnd: new Date(parsed.data.periodEnd),
          openingBalance: parsed.data.openingBalance,
          closingBalance: parsed.data.closingBalance,
          importedById: req.user.sub,
        },
        parsed.data.lines.map((l) => ({
          txnDate: new Date(l.txnDate),
          description: l.description,
          amount: l.amount,
          reference: l.reference,
          runningBalance: l.runningBalance,
        })),
      );
      await audit.record({
        action: "BANK_STATEMENT_IMPORT",
        actorId: req.user.sub,
        targetType: "BankStatement",
        targetId: statement.id,
        payload: {
          lines: parsed.data.lines.length,
          label: parsed.data.label,
        },
      });
      return reply.code(201).send(statement);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/statements/:id/auto-match",
    {
      preHandler: app.requirePermission("accounting.post_journal"),
      schema: routeSchema({
        summary:
          "Run the auto-matcher over the statement's unmatched lines. " +
          "Conservative — anything ambiguous is left for a human.",
        tags: TAGS,
        permission: "accounting.post_journal",
        params: statementIdParamSchema,
        response: autoMatchResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => {
      const { repo, audit } = req.reconciliationCtx!;
      const result = await repo.autoMatch(req.params.id);
      await audit.record({
        action: "BANK_STATEMENT_AUTO_MATCH",
        actorId: req.user.sub,
        targetType: "BankStatement",
        targetId: req.params.id,
        payload: { matched: result.matchedLines, amount: result.matchedAmount },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/lines/:id/match",
    {
      preHandler: app.requirePermission("accounting.post_journal"),
      schema: routeSchema({
        summary:
          "Pin a bank line to an internal record the auto-matcher could " +
          "not place. 409 if another line already claims that record.",
        tags: TAGS,
        permission: "accounting.post_journal",
        params: lineIdParamSchema,
        body: manualMatchSchema,
        response: lineResponseSchema,
        errors: [400, 401, 402, 403, 409],
      }),
    },
    async (req, reply) => {
      const parsed = manualMatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        return await req.reconciliationCtx!.repo.manualMatch(req.params.id, {
          ...parsed.data,
          userId: req.user.sub,
        });
      } catch (e) {
        // 409: the request is well-formed, the record is just already
        // spoken for — and the message names the line that has it.
        if (e instanceof BankLineAlreadyMatchedError) {
          return reply
            .code(409)
            .send({ error: e.code, message: e.message, lineId: e.lineId });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/lines/:id/unmatch",
    {
      preHandler: app.requirePermission("accounting.post_journal"),
      schema: routeSchema({
        summary:
          "Release a line's match, clearing every matched* field back to " +
          "null so the record it claimed is free again.",
        tags: TAGS,
        permission: "accounting.post_journal",
        params: lineIdParamSchema,
        response: lineResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.reconciliationCtx!.repo.unmatch(req.params.id),
  );

  /**
   * Scored match candidates for an unmatched line — used by the drawer
   * to surface suggestions before the human confirms one via /match.
   */
  app.get<{ Params: { id: string } }>(
    "/lines/:id/candidates",
    {
      preHandler: app.requirePermission("accounting.read"),
      schema: routeSchema({
        summary:
          "Scored match suggestions for one line, best first (up to 10). " +
          "Answers [] for an unknown line rather than 404.",
        tags: TAGS,
        permission: "accounting.read",
        params: lineIdParamSchema,
        response: candidateListResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.reconciliationCtx!.repo.candidatesFor(req.params.id, 10),
  );
}
