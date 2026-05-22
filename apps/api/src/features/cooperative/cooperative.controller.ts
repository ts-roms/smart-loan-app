import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { CooperativeService } from "./cooperative.service.js";
import {
  bigBrotherSchema,
  contributionSchema,
  expenseSchema,
  fundTxnSchema,
  otherIncomeSchema,
  savingsSchema,
  withdrawalSchema,
} from "./schemas.js";

/**
 * HTTP adapter for cooperative routes. 14 endpoints (list + create
 * for each of 7 entity types) + the member-ledger drawer feed. Every
 * create endpoint follows the same shape, so we collapse them via a
 * small helper to avoid repeating the same 5 lines fourteen times.
 */
export class CooperativeController {
  constructor(private readonly service: CooperativeService) {}

  // ─── reads ────────────────────────────────────────────────────────

  listContributions = async () => this.service.listContributions();
  listSavings = async () => this.service.listSavings();
  listFundTxns = async () => this.service.listFundTxns();
  listWithdrawals = async () => this.service.listWithdrawals();
  listExpenses = async () => this.service.listExpenses();
  listOtherIncome = async () => this.service.listOtherIncome();
  listBigBrother = async () => this.service.listBigBrother();

  memberLedger = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const ledger = await this.service.memberLedger(req.params.customerId);
    if (!ledger) return reply.code(404).send({ error: "NotFound" });
    return ledger;
  };

  // ─── writes ───────────────────────────────────────────────────────

  createContribution = this.makeCreate(contributionSchema, (input, actorId) =>
    this.service.createContribution({ input, actorId }),
  );
  createSavings = this.makeCreate(savingsSchema, (input, actorId) =>
    this.service.createSavings({ input, actorId }),
  );
  createFundTxn = this.makeCreate(fundTxnSchema, (input, actorId) =>
    this.service.createFundTxn({ input, actorId }),
  );
  createWithdrawal = this.makeCreate(withdrawalSchema, (input, actorId) =>
    this.service.createWithdrawal({ input, actorId }),
  );
  createExpense = this.makeCreate(expenseSchema, (input, actorId) =>
    this.service.createExpense({ input, actorId }),
  );
  createOtherIncome = this.makeCreate(otherIncomeSchema, (input, actorId) =>
    this.service.createOtherIncome({ input, actorId }),
  );
  createBigBrother = this.makeCreate(bigBrotherSchema, (input, actorId) =>
    this.service.createBigBrother({ input, actorId }),
  );

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Build a Fastify handler that:
   *   1. zod-parses the body (400 on failure)
   *   2. calls the service with `{ input, actorId: req.user.sub }`
   *   3. maps the discriminated union: 201 + row on ok, 400 + message
   *      on RepoError
   *
   * Returning a handler from a method needs `this`-binding — done by
   * the controller being instantiated once per plugin closure, and by
   * the handler closing over `runService`.
   */
  private makeCreate<S extends z.ZodTypeAny>(
    schema: S,
    runService: (
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
      const result = await runService(parsed.data, req.user.sub);
      if (!result.ok) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: result.message });
      }
      return reply.code(201).send(result.row);
    };
  }
}
