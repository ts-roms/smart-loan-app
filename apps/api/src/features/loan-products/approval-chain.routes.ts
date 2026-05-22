import { AuditLogRepository, LoanApprovalRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const stepSchema = z.object({
  order: z.number().int().min(1),
  label: z.string().min(1).max(120),
  requiredPermission: z.string().min(1).max(100),
  optional: z.boolean().optional(),
});

const chainSchema = z.object({
  steps: z.array(stepSchema).max(10),
});

/**
 * Loan-product approval-chain definition routes. Mounted under the
 * /loan-products prefix so paths read /loan-products/:code/approval-chain.
 *
 *   GET /:code/approval-chain  — read chain definition (products.read)
 *   PUT /:code/approval-chain  — replace chain (loans.approval.chain.manage)
 */
export async function loanApprovalChainRoutes(
  app: FastifyInstance,
): Promise<void> {
  const approvals = new LoanApprovalRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // Reading the chain is read-only — anyone with product read access.
  app.get<{ Params: { code: string } }>(
    "/:code/approval-chain",
    { preHandler: app.requirePermission("products.read") },
    async (req) => approvals.listSteps(req.params.code),
  );

  // Write requires a dedicated permission so only admins (or delegated
  // admins) can reshape the workflow.
  app.put<{ Params: { code: string } }>(
    "/:code/approval-chain",
    { preHandler: app.requirePermission("loans.approval.chain.manage") },
    async (req, reply) => {
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
