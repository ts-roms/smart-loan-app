import {
  AuditLogRepository,
  LoanApprovalRepository,
  LoanRepository,
} from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { notifyApproversForStep } from "./notify-approvers.js";

const approveSchema = z.object({
  notes: z.string().max(2000).optional(),
});

const rejectSchema = z.object({
  notes: z.string().min(1).max(2000),
});

/**
 * Loan-side approval routes. Mounted under the /loans prefix so paths
 * read /loans/:idOrNumber/approvals[/reject].
 *
 *   GET    /:id/approvals         — list rows (loans.read)
 *   POST   /:id/approvals         — approve current step
 *   POST   /:id/approvals/reject  — reject current step
 *
 * Step approve/reject — the repo re-checks the row's
 * `requiredPermission` inside the transaction so role / delegation
 * changes mid-flight can't slip past the HTTP gate. Per-step permission
 * isn't gated here at the route layer; the user just needs to be
 * authenticated. A 403 comes back from the repo's "you don't hold"
 * throw and we map that to a clean HTTP 403.
 */
export async function loanApprovalRoutes(app: FastifyInstance): Promise<void> {
  const loans = new LoanRepository(app.prisma);
  const approvals = new LoanApprovalRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // List approval rows for a loan. Read-only — anyone who can see the
  // loan can see its approval chain.
  app.get<{ Params: { id: string } }>(
    "/:id/approvals",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });
      return approvals.listForLoan(loan.id);
    },
  );

  app.post<{ Params: { id: string } }>("/:id/approvals", async (req, reply) => {
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const loan = await loans.findByIdOrNumber(req.params.id);
    if (!loan) return reply.code(404).send({ error: "NotFound" });
    try {
      const result = await approvals.approveStep({
        loanId: loan.id,
        approverId: req.user.sub,
        notes: parsed.data.notes,
      });
      await audit.record({
        action: "LOAN_APPROVAL_STEP",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: loan.id,
        payload: {
          loanNumber: loan.number,
          stepOrder: result.approval.stepOrder,
          stepLabel: result.approval.stepLabel,
          isFinal: result.isFinal,
          signedUnderDelegationId: result.approval.signedUnderDelegationId,
        },
      });
      // Hand-off notification: if the step that just landed isn't the
      // final one, the next step's approvers need to know they have
      // something waiting. Fire-and-forget so the HTTP response isn't
      // blocked on the dispatcher round-trip.
      if (!result.isFinal && result.nextStep) {
        void notifyApproversForStep(app, loan.id, result.nextStep);
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      // Permission denial → 403 so the UI can show a clean error;
      // other validation issues (already approved, wrong state) → 400.
      if (message.includes("don't hold")) {
        return reply.code(403).send({ error: "Forbidden", message });
      }
      return reply.code(400).send({ error: "BadRequest", message });
    }
  });

  // Reject. Notes mandatory.
  app.post<{ Params: { id: string } }>(
    "/:id/approvals/reject",
    async (req, reply) => {
      const parsed = rejectSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });
      try {
        const result = await approvals.rejectStep({
          loanId: loan.id,
          approverId: req.user.sub,
          notes: parsed.data.notes,
        });
        await audit.record({
          action: "LOAN_APPROVAL_REJECT",
          actorId: req.user.sub,
          targetType: "LoanApplication",
          targetId: loan.id,
          payload: {
            loanNumber: loan.number,
            stepOrder: result.stepOrder,
            stepLabel: result.stepLabel,
            notes: parsed.data.notes,
          },
        });
        return result;
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("don't hold")) {
          return reply.code(403).send({ error: "Forbidden", message });
        }
        return reply.code(400).send({ error: "BadRequest", message });
      }
    },
  );
}
