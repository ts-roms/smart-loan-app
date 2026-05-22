import { AccountingRepository, AuditLogRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { JournalController } from "./journal.controller.js";
import { JournalService } from "./journal.service.js";
import { accountSchema } from "./schemas.js";

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
 */
export async function accountingRoutes(app: FastifyInstance) {
  const accounting = new AccountingRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  // Application + presentation for the journal-write paths.
  const journalService = new JournalService(accounting, audit);
  const journal = new JournalController(journalService);

  app.addHook("preHandler", app.authenticate);

  // ─── Chart of accounts ─────────────────────────────────────────────

  app.get("/accounts", async () => accounting.listAccounts());

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
      return reply.code(201).send(await accounting.createAccount(parsed.data));
    },
  );

  app.post(
    "/accounts/seed",
    { preHandler: app.requirePermission("accounting.accounts") },
    async () => accounting.seedDefaultChart(),
  );

  // ─── Journal ────────────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; source?: string } }>(
    "/journal",
    async (req) =>
      accounting.listEntries({
        from: req.query.from ? new Date(req.query.from) : undefined,
        to: req.query.to ? new Date(req.query.to) : undefined,
        source: req.query.source,
      }),
  );

  // GET /accounting/journal/:idOrNumber — accept either form.
  app.get<{ Params: { id: string } }>("/journal/:id", async (req, reply) => {
    const e = await accounting.findEntryByIdOrNumber(req.params.id);
    if (!e) return reply.code(404).send({ error: "NotFound" });
    return e;
  });

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
  }>("/ledger/:accountId", async (req) =>
    accounting.ledgerFor(
      req.params.accountId,
      req.query.from ? new Date(req.query.from) : undefined,
      req.query.to ? new Date(req.query.to) : undefined,
    ),
  );

  // ─── Reports ────────────────────────────────────────────────────────

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/trial-balance",
    async (req) => accounting.trialBalance(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/income-statement",
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
      return accounting.incomeStatement(from, to);
    },
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/balance-sheet",
    async (req) => accounting.balanceSheet(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/loan-portfolio",
    async (req) => accounting.loanPortfolioAging(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/portfolio-summary",
    async (req) => accounting.portfolioSummary(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/originations",
    async (req) => {
      const to = parseAsOf(req.query.to);
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getFullYear(), to.getMonth() - 11, 1);
      return accounting.originationsByMonth(from, to);
    },
  );

  app.get("/reports/vintage", async () => accounting.vintageCohorts());

  // ─── Periods ────────────────────────────────────────────────────────

  app.get("/periods", async () => accounting.listPeriods());

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
      return accounting.closePeriod(year, month, req.user.sub);
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
        return await accounting.reopenPeriod(year, month);
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
        return await accounting.accrueMonthlyInterest(
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
