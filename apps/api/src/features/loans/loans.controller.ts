import type { FastifyReply, FastifyRequest } from "fastify";

import { applySchema, decideSchema, declarationAnswersSchema } from "./schemas";

/**
 * Loan-workflow HTTP adapter. Owns the four orchestration-heavy
 * endpoints; the other ~25 endpoints on /loans stay as inline handlers
 * in loans.routes.ts because they're thin repo passthroughs (see
 * docs/architecture.md — "earn its keep").
 *
 * **Phase 2 pattern**: stateless singleton. Each method reads the
 * per-request `LoanWorkflowService` from `req.loanCtx.workflowService`,
 * which the `buildLoanCtx` preHandler in loans.routes.ts instantiates
 * against the tenant-scoped Prisma client.
 *
 * Each method follows the same shape:
 *   1. zod-parse the body / params
 *   2. Call the service (read from req)
 *   3. Map the discriminated-union result to an HTTP code
 */
export class LoanWorkflowController {
  apply = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.loanCtx!.workflowService.apply(
      parsed.data,
      req.user.sub,
    );
    if (result.ok) {
      return reply.code(201).send(result.loan);
    }
    if (result.kind === "AmlBlocked") {
      return reply.code(409).send({
        error: "AmlBlocked",
        message: result.message,
        screeningId: result.screeningId,
      });
    }
    if (result.kind === "HasLiveLoan") {
      // 409, same family as AmlBlocked: the request is well-formed and
      // the refusal is about the customer's state, not the payload.
      return reply.code(409).send({
        error: "HasLiveLoan",
        message: result.message,
        liveLoans: result.liveLoans,
      });
    }
    // BadRequest — typically from the repo apply() validation (product
    // band check, etc.). The message is operator-facing.
    return reply.code(400).send({
      error: "BadRequest",
      message: result.message,
      issues: result.issues,
    });
  };

  dryRun = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.loanCtx!.workflowService.dryRun(parsed.data);
    if (!result.ok) {
      return reply.code(404).send({ error: result.kind });
    }
    return result.result;
  };

  decide = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.loanCtx!.workflowService.decide(
      req.params.id,
      parsed.data,
      req.user.sub,
    );
    if (result.ok) return result.loan;
    if (result.kind === "NotFound") {
      return reply.code(404).send({ error: "NotFound" });
    }
    if (result.kind === "ApprovalChainPending") {
      /*
       * Deliberately NOT overridable, unlike the KYC and declarations
       * gates below. Those say "the file is incomplete", and an admin
       * accepting that risk in writing is a legitimate call. This one
       * says "the people who are supposed to approve this haven't" —
       * an override flag would be a switch for skipping the control
       * itself, which is the opposite of what a chain is for.
       *
       * The remedy is to go and approve the steps, so the message names
       * them.
       */
      const names = result.pending
        .map((s) => `${s.stepOrder}. ${s.stepLabel}`)
        .join(", ");
      return reply.code(409).send({
        error: "ApprovalChainPending",
        message: `Cannot approve — ${result.pending.length} approval step(s) still outstanding: ${names}.`,
        pending: result.pending,
      });
    }
    if (result.kind === "DeclarationsIncomplete") {
      // Same 409 family as KycIncomplete — approval is blocked by KYC
      // posture, here the unanswered required declarations.
      return reply.code(409).send({
        error: "DeclarationsIncomplete",
        message: `Cannot approve ${result.loanProductCode} loan — ${result.unanswered.length} required declaration(s) unanswered.`,
        unanswered: result.unanswered,
      });
    }
    // KycIncomplete — block with the missing/rejected doc lists so the
    // UI can surface them in the decide dialog.
    return reply.code(409).send({
      error: "KycIncomplete",
      message: `Cannot approve ${result.loanProductCode} loan — KYC incomplete.`,
      missing: result.missing,
      rejected: result.rejected,
      status: result.status,
    });
  };

  answerDeclarations = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = declarationAnswersSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.loanCtx!.workflowService.answerDeclarations(
      req.params.id,
      parsed.data.answers,
      req.user.sub,
    );
    if (result.ok) return result.declarations;
    switch (result.kind) {
      case "NotFound":
        return reply.code(404).send({ error: "NotFound" });
      case "NotEditable":
        return reply.code(409).send({
          error: "NotEditable",
          message: `Declarations are frozen once a loan is ${result.status} — they are part of what the decision judged.`,
        });
      case "NoQuestionnaire":
        return reply.code(404).send({
          error: "NoQuestionnaire",
          message: "This product has no declaration questionnaire.",
        });
      case "InvalidAnswers":
        return reply
          .code(400)
          .send({ error: "InvalidAnswers", issues: result.invalid });
    }
  };

  disburse = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.loanCtx!.workflowService.disburse(
      req.params.id,
      req.user.sub,
    );
    if (!result.ok) {
      if (result.kind === "NotFound") {
        return reply.code(404).send({ error: "NotFound" });
      }
      // 409, with names: the officer needs to know who to chase, not
      // just that something is outstanding.
      return reply.code(409).send({
        error: "CoMakersPending",
        message: "Every co-maker has to approve before funds are released.",
        coMakers: result.coMakers,
      });
    }
    return result.loan;
  };
}
