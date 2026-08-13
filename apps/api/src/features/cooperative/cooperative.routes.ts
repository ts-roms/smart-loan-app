/**
 * Cooperative module routes. Seven entity types under `/cooperative/*`,
 * every mutation auto-posts to the GL via the CooperativeRepository.
 *
 *   GET  /contributions               coop.read
 *   POST /contributions               coop.contribute
 *   GET  /savings                     coop.read
 *   POST /savings                     coop.savings
 *   GET  /funds                       coop.read
 *   POST /funds                       coop.funds
 *   GET  /withdrawals                 coop.read
 *   POST /withdrawals                 coop.funds
 *   GET  /expenses                    coop.read
 *   POST /expenses                    coop.expense
 *   GET  /other-income                coop.read
 *   POST /other-income                coop.income
 *   GET  /big-brother                 coop.read
 *   POST /big-brother                 coop.big_brother
 *   GET  /members/:customerId/ledger  coop.read
 *
 * Layered: routes → controller → service → repo (which posts the
 * journal entry inside its own transaction). The journal IS the audit
 * trail for cooperative fund movement — no separate audit row written.
 */

import { CooperativeRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";

import { CooperativeController } from "./cooperative.controller";
import { CooperativeService } from "./cooperative.service";
import {
  bigBrotherResponseSchema,
  bigBrotherSchema,
  contributionResponseSchema,
  contributionSchema,
  expenseResponseSchema,
  expenseSchema,
  fundTransactionResponseSchema,
  fundTxnSchema,
  fundWithdrawalResponseSchema,
  memberLedgerParamSchema,
  memberLedgerResponseSchema,
  otherIncomeResponseSchema,
  otherIncomeSchema,
  savingsSchema,
  savingsTransactionResponseSchema,
  withdrawalSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    cooperativeServices?: { coop: CooperativeService };
  }
}

const TAGS = ["cooperative"];

export async function cooperativeRoutes(app: FastifyInstance) {
  // onRequest, not preHandler — routes in this group carry request
  // schemas, and Fastify validates at preValidation, BEFORE preHandler.
  // With authenticate at preHandler an unauthenticated caller with a
  // malformed body got a 400 describing the schema instead of a 401.
  // See decision-rules.routes.ts for the full account.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Cooperative module is ENTERPRISE-tier. Any of the three cooperative
  // flags unlocks the whole prefix; the platform CLI ships all three
  // together when a tenant gets ENTERPRISE. The gate reads req.tenantCtx,
  // so resolveTenant must run before it.
  app.addHook(
    "preHandler",
    app.requireFeature(
      "cooperative.contributions",
      "cooperative.savings",
      "cooperative.funds",
    ),
  );
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.cooperativeServices = {
      coop: new CooperativeService(
        new CooperativeRepository(req.tenantCtx.prisma),
      ),
    };
  });

  const ctrl = new CooperativeController();

  // ── contributions ──
  app.get(
    "/contributions",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary:
          "Latest 500 contribution rows, newest first. Fund columns are " +
          "Decimal strings.",
        tags: TAGS,
        response: z.array(contributionResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listContributions,
  );
  app.post(
    "/contributions",
    {
      preHandler: app.requirePermission("coop.contribute"),
      schema: routeSchema({
        summary:
          "Record a member contribution (CBU / mortuary / emergency — at " +
          "least one > 0) and post it to the GL in the same transaction.",
        tags: TAGS,
        body: contributionSchema,
        response: contributionResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createContribution,
  );

  // ── savings ──
  app.get(
    "/savings",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary: "Latest 500 savings transactions, newest first.",
        tags: TAGS,
        response: z.array(savingsTransactionResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listSavings,
  );
  app.post(
    "/savings",
    {
      preHandler: app.requirePermission("coop.savings"),
      schema: routeSchema({
        summary:
          "Record a savings deposit or withdrawal and post it to the GL. " +
          "`amount` is a number in; a Decimal STRING comes back.",
        tags: TAGS,
        body: savingsSchema,
        response: savingsTransactionResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createSavings,
  );

  // ── funds ──
  app.get(
    "/funds",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary: "Latest 500 fund inflows, newest first.",
        tags: TAGS,
        response: z.array(fundTransactionResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listFundTxns,
  );
  app.post(
    "/funds",
    {
      preHandler: app.requirePermission("coop.funds"),
      schema: routeSchema({
        summary:
          "Record a capital inflow to a fund (member or third-party) and " +
          "post it to the GL.",
        tags: TAGS,
        body: fundTxnSchema,
        response: fundTransactionResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createFundTxn,
  );

  // ── withdrawals ──
  app.get(
    "/withdrawals",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary: "Latest 500 fund withdrawals, newest first.",
        tags: TAGS,
        response: z.array(fundWithdrawalResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listWithdrawals,
  );
  app.post(
    "/withdrawals",
    {
      preHandler: app.requirePermission("coop.funds"),
      schema: routeSchema({
        summary:
          "Record a capital outflow from a fund and post it to the GL. " +
          "400 covers chart-of-accounts misconfiguration for the source.",
        tags: TAGS,
        body: withdrawalSchema,
        response: fundWithdrawalResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createWithdrawal,
  );

  // ── expenses ──
  app.get(
    "/expenses",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary: "Latest 500 expense rows, newest first.",
        tags: TAGS,
        response: z.array(expenseResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listExpenses,
  );
  app.post(
    "/expenses",
    {
      preHandler: app.requirePermission("coop.expense"),
      schema: routeSchema({
        summary:
          "Record an operating expense against a fund and post it to the GL.",
        tags: TAGS,
        body: expenseSchema,
        response: expenseResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createExpense,
  );

  // ── other income ──
  app.get(
    "/other-income",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary: "Latest 500 other-income rows, newest first.",
        tags: TAGS,
        response: z.array(otherIncomeResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listOtherIncome,
  );
  app.post(
    "/other-income",
    {
      preHandler: app.requirePermission("coop.income"),
      schema: routeSchema({
        summary:
          "Record non-lending income credited to a fund and post it to " +
          "the GL.",
        tags: TAGS,
        body: otherIncomeSchema,
        response: otherIncomeResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createOtherIncome,
  );

  // ── member ledger ──
  app.get<{ Params: { customerId: string } }>(
    "/members/:customerId/ledger",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary:
          "One member's cooperative position: rolled-up totals plus the " +
          "latest 20 contributions and savings rows.",
        tags: TAGS,
        params: memberLedgerParamSchema,
        response: memberLedgerResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    ctrl.memberLedger,
  );

  // ── big brother ──
  app.get(
    "/big-brother",
    {
      preHandler: app.requirePermission("coop.read"),
      schema: routeSchema({
        summary:
          "External capital accounts (Big Brother), newest first. " +
          "`capital` is a Decimal string.",
        tags: TAGS,
        response: z.array(bigBrotherResponseSchema),
        errors: [401, 402, 403],
      }),
    },
    ctrl.listBigBrother,
  );
  app.post(
    "/big-brother",
    {
      preHandler: app.requirePermission("coop.big_brother"),
      schema: routeSchema({
        summary:
          "Register an external capital injection for a fixed period and " +
          "post the liability to the GL. 400 covers periodTo ≤ periodFrom.",
        tags: TAGS,
        body: bigBrotherSchema,
        response: bigBrotherResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.createBigBrother,
  );
}
