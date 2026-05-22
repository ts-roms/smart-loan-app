import { LoanApprovalRepository, type PrismaClient } from "@loan/db";
import type { FastifyInstance } from "fastify";

/**
 * Dispatch "loan needs your approval" notifications to every user
 * authorized for the loan's current step. Best-effort: errors here are
 * swallowed so a downed notification provider can never block the
 * approval/submit it was reporting on.
 *
 * Two callers depend on this:
 *   • loans.routes.ts — step 1 fan-out at submit time
 *   • approvals.routes.ts — next-step fan-out after advancing
 *
 * Keeping the recipient lookup + per-channel dispatch in one place
 * ensures both code paths render the same templates with the same
 * context.
 *
 * Phase 2: takes the tenant-scoped Prisma client explicitly. Callers
 * pass `req.tenantCtx.prisma` so the lookup hits the right schema.
 */
export async function notifyApproversForStep(
  app: FastifyInstance,
  prisma: PrismaClient,
  loanId: string,
  stepOrder: number,
): Promise<void> {
  try {
    // Pull just enough of the loan to template the message — and the
    // step row to know which permission to broadcast against. We do this
    // inside the helper instead of taking already-fetched data so callers
    // don't have to plumb the customer + product + step relations
    // themselves.
    const loan = await prisma.loanApplication.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        number: true,
        principal: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
    const step = await prisma.loanApproval.findUnique({
      where: { loanId_stepOrder: { loanId, stepOrder } },
      select: { stepLabel: true, requiredPermission: true, status: true },
    });
    if (!loan || !step || step.status !== "PENDING") return;

    const approvalsRepo = new LoanApprovalRepository(prisma);
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
      // IN_APP — surfaces in the navbar bell. Recipient is the email
      // since the bell renders it; the body still personalises by
      // recipientName for the staff seeing their own row.
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
