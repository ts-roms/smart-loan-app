import type { FastifyReply, FastifyRequest } from "fastify";

import { applySchema, decideSchema } from "./schemas";
import type { LoanWorkflowService } from "./loans.service";

/**
 * Loan-workflow HTTP adapter. Owns the four orchestration-heavy
 * endpoints; the other ~25 endpoints on /loans stay as inline handlers
 * in loans.routes.ts because they're thin repo passthroughs (see
 * docs/architecture.md — "earn its keep").
 *
 * Each method follows the same shape:
 *   1. zod-parse the body / params
 *   2. Call the service
 *   3. Map the discriminated-union result to an HTTP code
 */
export class LoanWorkflowController {
  constructor(private readonly service: LoanWorkflowService) {}

  apply = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.apply(parsed.data, req.user.sub);
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
    const result = await this.service.dryRun(parsed.data);
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
    const result = await this.service.decide(
      req.params.id,
      parsed.data,
      req.user.sub,
    );
    if (result.ok) return result.loan;
    if (result.kind === "NotFound") {
      return reply.code(404).send({ error: "NotFound" });
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

  disburse = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    return this.service.disburse(req.params.id, req.user.sub);
  };
}
