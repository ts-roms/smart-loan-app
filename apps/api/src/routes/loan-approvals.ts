/**
 * Loan approval chain endpoints.
 *
 *   GET    /loans/:idOrNumber/approvals                 — list rows
 *   POST   /loans/:idOrNumber/approvals                 — approve current step
 *   POST   /loans/:idOrNumber/approvals/reject          — reject current step
 *   GET    /loan-products/:code/approval-chain          — read chain definition
 *   PUT    /loan-products/:code/approval-chain          — replace chain definition
 *
 * Authority:
 *   • Step approve/reject — repo re-checks the row's `requiredPermission`
 *     inside the transaction so role / delegation changes mid-flight
 *     can't slip past the HTTP gate.
 *   • Chain CRUD — `loans.approval.chain.manage` (ADMIN by default).
 *
 * Routes mounted under their respective parent prefixes by the registry.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AuditLogRepository,
  LoanApprovalRepository,
  LoanRepository,
} from "@loan/db";

/**
 * Dispatch "loan needs your approval" notifications to every user
 * authorized for the loan's current step. Best-effort: errors here are
 * swallowed so a downed notification provider can never block the
 * approval/submit it was reporting on.
 *
 * Exported because both the loan-apply route (step 1 fan-out at submit
 * time) and the approve-step route (next-step fan-out after advancing)
 * call this. Keeping the recipient lookup + per-channel dispatch in one
 * place ensures both code paths render the same templates with the
 * same context.
 */
export async function notifyApproversForStep(
  app: FastifyInstance,
  loanId: string,
  stepOrder: number,
): Promise<void> {
  try {
    // Pull just enough of the loan to template the message — and the
    // step row to know which permission to broadcast against. We do this
    // inside the helper instead of taking already-fetched data so callers
    // don't have to plumb the customer + product + step relations
    // themselves.
    const loan = await app.prisma.loanApplication.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        number: true,
        principal: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
    const step = await app.prisma.loanApproval.findUnique({
      where: { loanId_stepOrder: { loanId, stepOrder } },
      select: { stepLabel: true, requiredPermission: true, status: true },
    });
    if (!loan || !step || step.status !== "PENDING") return;

    const approvalsRepo = new LoanApprovalRepository(app.prisma);
    const recipients = await approvalsRepo.findApproversForPermission(
      step.requiredPermission,
    );
    if (recipients.length === 0) {
      // Edge case worth logging: a chain step references a permission
      // nobody currently holds. The loan would block until someone is
      // granted the permission, so the operator should know.
      app.log.warn(
        { loanId, stepOrder, permission: step.requiredPermission },
        "No authorized approvers found for step",
      );
      return;
    }

    const borrowerName = loan.customer
      ? `${loan.customer.firstName} ${loan.customer.lastName}`
      : "borrower";

    // Fan out to each recipient × channel. Errors per-row are swallowed
    // inside dispatch (the repo already marks the row FAILED), so we
    // don't need a per-iteration try/catch here.
    for (const u of recipients) {
      const data = {
        recipientName: u.name,
        loanNumber: loan.number,
        borrowerName,
        amount: Number(loan.principal),
        stepLabel: step.stepLabel,
      };
      // IN_APP — surfaces in the navbar bell. Email is the addressee
      // handle since the bell renders it; the body still personalises
      // by recipientName for the staff seeing their own row.
      await app.notifications.dispatch({
        event: "LOAN_APPROVAL_PENDING",
        channel: "IN_APP",
        recipient: u.email,
        data,
        refType: "LoanApplication",
        refId: loan.id,
      });
      // EMAIL — only when the user has an address on file (all staff
      // should, but defensive).
      if (u.email) {
        await app.notifications.dispatch({
          event: "LOAN_APPROVAL_PENDING",
          channel: "EMAIL",
          recipient: u.email,
          data,
          refType: "LoanApplication",
          refId: loan.id,
        });
      }
    }
  } catch (err) {
    // Non-fatal — log and continue. The approve action itself already
    // committed, so refusing the request now would be worse than a
    // missed notification.
    app.log.error({ err, loanId, stepOrder }, "notifyApproversForStep failed");
  }
}

const approveSchema = z.object({
  notes: z.string().max(2000).optional(),
});

const rejectSchema = z.object({
  notes: z.string().min(1).max(2000),
});

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
 * Loan-side routes — mounted under /loans so the path reads
 * /loans/:idOrNumber/approvals.
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

  // Approve the current pending step. Repo enforces the per-step
  // permission via resolveEffectivePermissions, so we don't gate by a
  // specific key here — the user just needs to be authenticated. A 403
  // gets surfaced from the repo's "you don't hold" throw.
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
      // Permission denial gets a 403 so the UI can show a clean error;
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

/**
 * Product-side routes — mounted under /loan-products so the path reads
 * /loan-products/:code/approval-chain.
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
