import {
  AuditLogRepository,
  isApprovalKycBlocked,
  LoanApprovalRepository,
  LoanRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";
import { notifyApproversForStep } from "./notify-approvers";
import {
  approveStepResponseSchema,
  loanApprovalListResponseSchema,
  loanApprovalResponseSchema,
  loanIdParamSchema,
} from "./schemas";

const TAGS = ["loans"];

const approveSchema = z.object({
  notes: z.string().max(2000).optional(),
  /*
   * Only meaningful on the final step, which is the one that approves
   * the loan. Mirrors the flag `POST /loans/:id/decide` already takes,
   * and means the same thing there and here.
   */
  overrideKyc: z.boolean().optional(),
});

const rejectSchema = z.object({
  notes: z.string().min(1).max(2000),
});

/**
 * Per-request context for the loan-approval surface. Same shape as
 * the parent loans feature, just narrower — these routes only need
 * three repos.
 */
interface ApprovalRouteCtx {
  loans: LoanRepository;
  approvals: LoanApprovalRepository;
  audit: AuditLogRepository;
}

declare module "fastify" {
  interface FastifyRequest {
    approvalCtx?: ApprovalRouteCtx;
  }
}

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
 *
 * Phase 2: per-request repo wiring against `req.tenantCtx.prisma`.
 */
export async function loanApprovalRoutes(app: FastifyInstance): Promise<void> {
  // onRequest, not preHandler — these routes carry request schemas, and
  // authentication has to precede schema validation or an anonymous
  // caller with a bad body gets a 400 instead of a 401. See
  // decision-rules.routes.ts.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", buildApprovalCtx());

  // List approval rows for a loan. Read-only — anyone who can see the
  // loan can see its approval chain.
  app.get<{ Params: { id: string } }>(
    "/:id/approvals",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary: "The loan's approval chain, in step order.",
        tags: TAGS,
        permission: "loans.read",
        params: loanIdParamSchema,
        response: loanApprovalListResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    async (req, reply) => {
      const { loans, approvals } = req.approvalCtx!;
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });
      return approvals.listForLoan(loan.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/approvals",
    {
      schema: routeSchema({
        summary:
          "Approve the current step. Per-step permission is enforced in " +
          "the transaction; wrong-state refusals answer 400 here. The " +
          "final step also re-checks KYC and declarations, answering " +
          "409 when they block approval unless overrideKyc is set.",
        tags: TAGS,
        params: loanIdParamSchema,
        body: approveSchema,
        response: approveStepResponseSchema,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    async (req, reply) => {
      const { loans, approvals, audit } = req.approvalCtx!;
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
          overrideKyc: parsed.data.overrideKyc,
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
        // blocked on the dispatcher round-trip. Uses the tenant-scoped
        // prisma client so the lookup hits the right schema.
        if (!result.isFinal && result.nextStep) {
          const prisma = req.tenantCtx.prisma;
          void notifyApproversForStep(
            app,
            prisma,
            app.notifications(prisma),
            loan.id,
            result.nextStep,
          );
        }
        return result;
      } catch (err) {
        const message = (err as Error).message;
        // Permission denial → 403 so the UI can show a clean error;
        // other validation issues (already approved, wrong state) → 400.
        if (message.includes("don't hold")) {
          return reply.code(403).send({ error: "Forbidden", message });
        }
        /*
         * KYC and declarations refusals answer 409, matching what
         * `POST /loans/:id/decide` already answers for the identical
         * two refusals. The same incomplete file should not produce a
         * different status code depending on which endpoint the
         * officer happened to use.
         */
        if (isApprovalKycBlocked(err)) {
          return reply.code(409).send({ error: err.kind, message });
        }
        return reply.code(400).send({ error: "BadRequest", message });
      }
    },
  );

  // Reject. Notes mandatory.
  app.post<{ Params: { id: string } }>(
    "/:id/approvals/reject",
    {
      schema: routeSchema({
        summary:
          "Reject the current step — terminal for the loan. Notes are " +
          "mandatory; wrong-state refusals answer 400 here.",
        tags: TAGS,
        params: loanIdParamSchema,
        body: rejectSchema,
        response: loanApprovalResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    async (req, reply) => {
      const { loans, approvals, audit } = req.approvalCtx!;
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

function buildApprovalCtx() {
  return async (req: FastifyRequest): Promise<void> => {
    const prisma = req.tenantCtx.prisma;
    req.approvalCtx = {
      loans: new LoanRepository(prisma),
      approvals: new LoanApprovalRepository(prisma),
      audit: new AuditLogRepository(prisma, req.user?.impersonatedBy),
    };
  };
}
