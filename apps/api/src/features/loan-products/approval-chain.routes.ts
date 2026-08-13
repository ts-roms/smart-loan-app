import { AuditLogRepository, LoanApprovalRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";
import { approvalChainResponseSchema, productCodeParamSchema } from "./schemas";

const stepSchema = z.object({
  order: z.number().int().min(1),
  label: z.string().min(1).max(120),
  requiredPermission: z.string().min(1).max(100),
  optional: z.boolean().optional(),
});

const chainSchema = z.object({
  steps: z.array(stepSchema).max(10),
});

declare module "fastify" {
  interface FastifyRequest {
    approvalChainCtx?: {
      approvals: LoanApprovalRepository;
      audit: AuditLogRepository;
    };
  }
}

/**
 * Loan-product approval-chain definition routes. Mounted under the
 * /loan-products prefix so paths read /loan-products/:code/approval-chain.
 *
 *   GET /:code/approval-chain  — read chain definition (products.read)
 *   PUT /:code/approval-chain  — replace chain (loans.approval.chain.manage)
 *
 * Phase 2: per-request repo wiring against `req.tenantCtx.prisma`.
 */
export async function loanApprovalChainRoutes(
  app: FastifyInstance,
): Promise<void> {
  // onRequest, not preHandler. The PUT below now declares a body
  // schema, and Fastify validates at preValidation — before preHandler.
  // With authenticate one stage later, an unauthenticated PUT with a
  // malformed body was answered 400 describing the chain-step shape
  // rather than 401. See loans.routes.ts for the full account.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.approvalChainCtx = {
      approvals: new LoanApprovalRepository(prisma),
      audit: new AuditLogRepository(prisma, req.user?.impersonatedBy),
    };
  });

  const TAGS = ["loan-products"];

  // Reading the chain is read-only — anyone with product read access.
  app.get<{ Params: { code: string } }>(
    "/:code/approval-chain",
    {
      preHandler: app.requirePermission("products.read"),
      schema: routeSchema({
        summary:
          "The product's approval chain, in order. An empty array means " +
          "no chain — the legacy single-decide flow applies.",
        tags: TAGS,
        params: productCodeParamSchema,
        response: approvalChainResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.approvalChainCtx!.approvals.listSteps(req.params.code),
  );

  // Write requires a dedicated permission so only admins (or delegated
  // admins) can reshape the workflow.
  app.put<{ Params: { code: string } }>(
    "/:code/approval-chain",
    {
      preHandler: app.requirePermission("loans.approval.chain.manage"),
      schema: routeSchema({
        summary:
          "Replace the product's approval chain. Steps are renumbered " +
          "1..N, so the orders you send back may not be the ones you sent.",
        tags: TAGS,
        params: productCodeParamSchema,
        body: chainSchema,
        response: approvalChainResponseSchema,
        // 400 also covers a duplicate `order` in the payload — the repo
        // would renumber it away, which is almost always an editor bug.
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const { approvals, audit } = req.approvalChainCtx!;
      const parsed = chainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      // Ensure orders are unique within the payload — the repo normalises
      // to 1..N but a duplicate in the input is almost certainly an
      // editor bug, so reject loudly.
      const orders = parsed.data.steps.map((s) => s.order);
      if (new Set(orders).size !== orders.length) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Duplicate step order." });
      }
      const saved = await approvals.saveSteps(
        req.params.code,
        parsed.data.steps,
      );
      await audit.record({
        action: "LOAN_APPROVAL_CHAIN_UPDATE",
        actorId: req.user.sub,
        targetType: "LoanProduct",
        targetId: req.params.code,
        payload: {
          stepCount: saved.length,
          steps: saved.map((s) => ({
            order: s.order,
            label: s.label,
            perm: s.requiredPermission,
          })),
        },
      });
      return saved;
    },
  );
}
