import { AccountingRepository, AuditLogRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { JournalController } from "./journal.controller";
import { JournalService } from "./journal.service";
import { accountSchema } from "./schemas";

/**
 * Helper for the report endpoints — defaults to "now" when `asOf` is
 * absent, rejects garbage dates with a thrown Error (the routes catch
 * it via the validate-on-call pattern).
 */
function parseAsOf(value: string | undefined): Date {
  if (!value) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  return d;
}

interface AccountingCtx {
  accounting: AccountingRepository;
  journal: JournalService;
}

declare module "fastify" {
  interface FastifyRequest {
    accountingCtx?: AccountingCtx;
  }
}

/**
 * Accounting feature plugin. Mixed layering:
 *
 *   • Journal write paths (POST /journal, POST /journal/:id/reverse,
 *     POST /journal/reverse-bulk) delegate to JournalController — they
 *     have real orchestration (audit coupling, balance validation,
 *     per-row bulk results).
 *
 *   • Everything else (COA, journal read, ledger, reports, periods,
 *     accrual jobs) stays as direct AccountingRepository calls inline
 *     below. Per docs/architecture.md "earn its keep" — adding a
 *     service for pure read/CRUD passthroughs is ceremony.
 *
 * Phase 2: per-request wiring via `req.accountingCtx`. Inline handlers
 * read from req.accountingCtx!.accounting; the JournalController is
 * stateless and reads req.accountingCtx!.journal directly.
 *
 * Authorization: every read is `accounting.read` (LOAN_OFFICER,
 * ACCOUNTANT, ADMIN) and every write keeps its narrower key
 * (accounting.accounts / post_journal / reverse / close_period /
 * accrue, ACCOUNTANT + ADMIN). Nothing in this feature is
 * customer-reachable — the trial balance, balance sheet and general
 * ledger are the firm's whole book of business.
 */
export async function accountingRoutes(app: FastifyInstance) {
  const journal = new JournalController();

  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    const accounting = new AccountingRepository(prisma);
    const audit = new AuditLogRepository(prisma, req.user?.impersonatedBy);
    req.accountingCtx = {
      accounting,
      journal: new JournalService(accounting, audit),
    };
  });

  // Shared route options for the read surface. Hoisted because eleven
  // endpoints repeat it; `requirePermission` returns a fresh closure
  // per call, so building it once is also one less allocation.
  const read = { preHandler: app.requirePermission("accounting.read") };

  // ─── Chart of accounts ─────────────────────────────────────────────

  app.get("/accounts", read, async (req) =>
    req.accountingCtx!.accounting.listAccounts(),
  );

  app.post(
    "/accounts",
    { preHandler: app.requirePermission("accounting.accounts") },
    async (req, reply) => {
      const parsed = accountSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return reply
        .code(201)
        .send(await req.accountingCtx!.accounting.createAccount(parsed.data));
    },
  );

  app.post(
    "/accounts/seed",
    { preHandler: app.requirePermission("accounting.accounts") },
    async (req) => req.accountingCtx!.accounting.seedDefaultChart(),
  );

  // ─── Journal ────────────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; source?: string } }>(
    "/journal",
    read,
    async (req) =>
      req.accountingCtx!.accounting.listEntries({
        from: req.query.from ? new Date(req.query.from) : undefined,
        to: req.query.to ? new Date(req.query.to) : undefined,
        source: req.query.source,
      }),
  );

  // GET /accounting/journal/:idOrNumber — accept either form.
  app.get<{ Params: { id: string } }>(
    "/journal/:id",
    read,
    async (req, reply) => {
      const e = await req.accountingCtx!.accounting.findEntryByIdOrNumber(
        req.params.id,
      );
      if (!e) return reply.code(404).send({ error: "NotFound" });
      return e;
    },
  );

  // Journal write paths — delegated to JournalController.
  app.post(
    "/journal",
    { preHandler: app.requirePermission("accounting.post_journal") },
    journal.post,
  );
  app.post<{ Params: { id: string } }>(
    "/journal/:id/reverse",
    { preHandler: app.requirePermission("accounting.reverse") },
    journal.reverse,
  );
  app.post(
    "/journal/reverse-bulk",
    { preHandler: app.requirePermission("accounting.reverse") },
    journal.reverseBulk,
  );

  // ─── Ledger ─────────────────────────────────────────────────────────

  app.get<{
    Params: { accountId: string };
    Querystring: { from?: string; to?: string };
  }>("/ledger/:accountId", read, async (req) =>
    req.accountingCtx!.accounting.ledgerFor(
      req.params.accountId,
      req.query.from ? new Date(req.query.from) : undefined,
      req.query.to ? new Date(req.query.to) : undefined,
    ),
  );

  // ─── Reports ────────────────────────────────────────────────────────

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/trial-balance",
    read,
    async (req) =>
      req.accountingCtx!.accounting.trialBalance(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/income-statement",
    read,
    async (req, reply) => {
      const to = parseAsOf(req.query.to);
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getFullYear(), 0, 1);
      if (Number.isNaN(from.getTime())) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Invalid from date" });
      }
      return req.accountingCtx!.accounting.incomeStatement(from, to);
    },
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/balance-sheet",
    read,
    async (req) =>
      req.accountingCtx!.accounting.balanceSheet(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/loan-portfolio",
    read,
    async (req) =>
      req.accountingCtx!.accounting.loanPortfolioAging(
        parseAsOf(req.query.asOf),
      ),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/portfolio-summary",
    read,
    async (req) =>
      req.accountingCtx!.accounting.portfolioSummary(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/originations",
    read,
    async (req) => {
      const to = parseAsOf(req.query.to);
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getFullYear(), to.getMonth() - 11, 1);
      return req.accountingCtx!.accounting.originationsByMonth(from, to);
    },
  );

  app.get("/reports/vintage", read, async (req) =>
    req.accountingCtx!.accounting.vintageCohorts(),
  );

  // ─── Periods ────────────────────────────────────────────────────────

  app.get("/periods", read, async (req) =>
    req.accountingCtx!.accounting.listPeriods(),
  );

  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/close",
    { preHandler: app.requirePermission("accounting.close_period") },
    async (req, reply) => {
      const year = Number(req.params.year);
      const month = Number(req.params.month);
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
      ) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Invalid year/month" });
      }
      return req.accountingCtx!.accounting.closePeriod(
        year,
        month,
        req.user.sub,
      );
    },
  );

  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/reopen",
    { preHandler: app.requirePermission("accounting.close_period") },
    async (req, reply) => {
      const year = Number(req.params.year);
      const month = Number(req.params.month);
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
      ) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Invalid year/month" });
      }
      try {
        return await req.accountingCtx!.accounting.reopenPeriod(year, month);
      } catch (err) {
        return reply.code(404).send({
          error: "NotFound",
          message: (err as Error).message,
        });
      }
    },
  );

  // ─── Accrual jobs ────────────────────────────────────────────────────

  /**
   * Idempotent interest accrual for the named period. Default = current
   * month. Returns { posted, skipped }. Safe to re-run; existing entries
   * for the same installment are detected by postIfAbsent.
   */
  app.post<{ Body?: { year?: number; month?: number } }>(
    "/jobs/accrue-interest",
    { preHandler: app.requirePermission("accounting.accrue") },
    async (req, reply) => {
      const now = new Date();
      const year = req.body?.year ?? now.getFullYear();
      const month = req.body?.month ?? now.getMonth() + 1;
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
      ) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Invalid year/month" });
      }
      try {
        return await req.accountingCtx!.accounting.accrueMonthlyInterest(
          { year, month },
          req.user.sub,
        );
      } catch (err) {
        return reply.code(409).send({
          error: "AccrualFailed",
          message: (err as Error).message,
        });
      }
    },
  );
}
