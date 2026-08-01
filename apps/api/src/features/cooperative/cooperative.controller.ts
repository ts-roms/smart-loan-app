import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { CooperativeService } from "./cooperative.service";
import {
  bigBrotherSchema,
  contributionSchema,
  expenseSchema,
  fundTxnSchema,
  otherIncomeSchema,
  savingsSchema,
  withdrawalSchema,
} from "./schemas";

/**
 * HTTP adapter for cooperative routes. 14 endpoints (list + create
 * for each of 7 entity types) + the member-ledger drawer feed.
 *
 * Phase 2: stateless. Reads `req.cooperativeServices!.coop` per call.
 * The create helper takes a closure that pulls the service from req.
 */
export class CooperativeController {
  // ─── reads ────────────────────────────────────────────────────────

  listContributions = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listContributions();
  listSavings = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listSavings();
  listFundTxns = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listFundTxns();
  listWithdrawals = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listWithdrawals();
  listExpenses = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listExpenses();
  listOtherIncome = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listOtherIncome();
  listBigBrother = async (req: FastifyRequest) =>
    req.cooperativeServices!.coop.listBigBrother();

  memberLedger = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const ledger = await req.cooperativeServices!.coop.memberLedger(
      req.params.customerId,
    );
    if (!ledger) return reply.code(404).send({ error: "NotFound" });
    return ledger;
  };

  // ─── writes ───────────────────────────────────────────────────────

  createContribution = this.makeCreate(
    contributionSchema,
    (svc, input, actorId) => svc.createContribution({ input, actorId }),
  );
  createSavings = this.makeCreate(savingsSchema, (svc, input, actorId) =>
    svc.createSavings({ input, actorId }),
  );
  createFundTxn = this.makeCreate(fundTxnSchema, (svc, input, actorId) =>
    svc.createFundTxn({ input, actorId }),
  );
  createWithdrawal = this.makeCreate(withdrawalSchema, (svc, input, actorId) =>
    svc.createWithdrawal({ input, actorId }),
  );
  createExpense = this.makeCreate(expenseSchema, (svc, input, actorId) =>
    svc.createExpense({ input, actorId }),
  );
  createOtherIncome = this.makeCreate(
    otherIncomeSchema,
    (svc, input, actorId) => svc.createOtherIncome({ input, actorId }),
  );
  createBigBrother = this.makeCreate(bigBrotherSchema, (svc, input, actorId) =>
    svc.createBigBrother({ input, actorId }),
  );

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Build a Fastify handler that reads the per-request CooperativeService
   * from `req.cooperativeServices.coop`, parses the body, runs the
   * service call, and maps the result to HTTP.
   */
  private makeCreate<S extends z.ZodTypeAny>(
    schema: S,
    runService: (
      svc: CooperativeService,
      input: z.infer<S>,
      actorId: string,
    ) => Promise<
      { ok: true; row: unknown } | { ok: false; kind: string; message: string }
    >,
  ) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      // `z.ZodTypeAny` erases the output type, so `parsed.data` lands as
      // `any` and would silently disable checking on the service call.
      // The runtime value is exactly `z.infer<S>` — only the static type
      // was lost — so re-assert it rather than passing `any` through.
      const input = parsed.data as z.infer<S>;
      const result = await runService(
        req.cooperativeServices!.coop,
        input,
        req.user.sub,
      );
      if (!result.ok) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: result.message });
      }
      return reply.code(201).send(result.row);
    };
  }
}
