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

import { CooperativeController } from "./cooperative.controller";
import { CooperativeService } from "./cooperative.service";

declare module "fastify" {
  interface FastifyRequest {
    cooperativeServices?: { coop: CooperativeService };
  }
}

export async function cooperativeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
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
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listContributions,
  );
  app.post(
    "/contributions",
    { preHandler: app.requirePermission("coop.contribute") },
    ctrl.createContribution,
  );

  // ── savings ──
  app.get(
    "/savings",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listSavings,
  );
  app.post(
    "/savings",
    { preHandler: app.requirePermission("coop.savings") },
    ctrl.createSavings,
  );

  // ── funds ──
  app.get(
    "/funds",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listFundTxns,
  );
  app.post(
    "/funds",
    { preHandler: app.requirePermission("coop.funds") },
    ctrl.createFundTxn,
  );

  // ── withdrawals ──
  app.get(
    "/withdrawals",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listWithdrawals,
  );
  app.post(
    "/withdrawals",
    { preHandler: app.requirePermission("coop.funds") },
    ctrl.createWithdrawal,
  );

  // ── expenses ──
  app.get(
    "/expenses",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listExpenses,
  );
  app.post(
    "/expenses",
    { preHandler: app.requirePermission("coop.expense") },
    ctrl.createExpense,
  );

  // ── other income ──
  app.get(
    "/other-income",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listOtherIncome,
  );
  app.post(
    "/other-income",
    { preHandler: app.requirePermission("coop.income") },
    ctrl.createOtherIncome,
  );

  // ── member ledger ──
  app.get<{ Params: { customerId: string } }>(
    "/members/:customerId/ledger",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.memberLedger,
  );

  // ── big brother ──
  app.get(
    "/big-brother",
    { preHandler: app.requirePermission("coop.read") },
    ctrl.listBigBrother,
  );
  app.post(
    "/big-brother",
    { preHandler: app.requirePermission("coop.big_brother") },
    ctrl.createBigBrother,
  );
}
