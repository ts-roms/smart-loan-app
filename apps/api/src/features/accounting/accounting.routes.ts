import { endOfDay, startOfDay } from "@loan/accounting";
import { AccountingRepository, AuditLogRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { JournalController } from "./journal.controller";
import { JournalService } from "./journal.service";
import {
  accountIdParamSchema,
  accountListResponseSchema,
  accountResponseSchema,
  accountSchema,
  accrueResponseSchema,
  asOfQuerySchema,
  balanceSheetResponseSchema,
  entrySchema,
  incomeStatementResponseSchema,
  journalEntryDetailResponseSchema,
  journalEntryListResponseSchema,
  journalEntryResponseSchema,
  journalIdParamSchema,
  journalQuerySchema,
  ledgerResponseSchema,
  loanPortfolioAgingResponseSchema,
  originationsResponseSchema,
  periodListResponseSchema,
  periodParamSchema,
  periodResponseSchema,
  portfolioSummaryResponseSchema,
  rangeQuerySchema,
  reverseSingleResponseSchema,
  seedChartResponseSchema,
  trialBalanceResponseSchema,
  vintageResponseSchema,
} from "./schemas";

const TAGS = ["accounting"];

/**
 * Upper bound for a report — `asOf` or `to`. Defaults to "now" when
 * absent, rejects garbage with a thrown Error (the routes catch it via
 * the validate-on-call pattern).
 *
 * `endOfDay`, not `new Date`. A bare "2026-08-07" parses as UTC
 * midnight, which is 8am in Manila, so every report asked for as-of
 * today silently dropped the working day that produced it — ₱15,668.78
 * of entries on this repo's own fixtures. A caller sending a full
 * timestamp still gets exactly that instant; only the ambiguous
 * date-only shape is widened. See `endOfDay` in @loan/accounting.
 */
function parseAsOf(value: string | undefined): Date {
  if (!value) return new Date();
  const d = endOfDay(value);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  return d;
}

/** Lower bound — the same treatment, anchored at the other end. */
function parseFrom(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = startOfDay(value);
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

  /*
   * Every read below is `accounting.read` behind `app.authenticate`, so
   * 401 and 403 are the two failures they share and nothing else — the
   * report handlers throw on an unparseable date rather than answering
   * 400, so claiming 400 here would document a response the API does
   * not produce.
   */
  const readErrors = [401, 403] as const;

  // ─── Chart of accounts ─────────────────────────────────────────────

  app.get(
    "/accounts",
    {
      ...read,
      schema: routeSchema({
        summary: "The chart of accounts, by code.",
        tags: TAGS,
        response: accountListResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) => req.accountingCtx!.accounting.listAccounts(),
  );

  app.post(
    "/accounts",
    {
      preHandler: app.requirePermission("accounting.accounts"),
      schema: routeSchema({
        summary: "Add an account to the chart.",
        tags: TAGS,
        body: accountSchema,
        response: accountResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
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
    {
      preHandler: app.requirePermission("accounting.accounts"),
      schema: routeSchema({
        summary: "Idempotently seed the shipped chart of accounts.",
        tags: TAGS,
        response: seedChartResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.accountingCtx!.accounting.seedDefaultChart(),
  );

  // ─── Journal ────────────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; source?: string } }>(
    "/journal",
    {
      ...read,
      schema: routeSchema({
        summary: "Journal entries in the range, newest first. Capped at 500.",
        tags: TAGS,
        querystring: journalQuerySchema,
        response: journalEntryListResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.listEntries({
        from: parseFrom(req.query.from),
        to: req.query.to ? parseAsOf(req.query.to) : undefined,
        source: req.query.source,
      }),
  );

  // GET /accounting/journal/:idOrNumber — accept either form.
  app.get<{ Params: { id: string } }>(
    "/journal/:id",
    {
      ...read,
      schema: routeSchema({
        summary: "One entry, by id or by its JE- number.",
        tags: TAGS,
        params: journalIdParamSchema,
        response: journalEntryDetailResponseSchema,
        errors: [401, 403, 404],
      }),
    },
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
    {
      preHandler: app.requirePermission("accounting.post_journal"),
      schema: routeSchema({
        summary: "Post a manual, balanced journal entry.",
        tags: TAGS,
        body: entrySchema,
        // The 201 carries the entry ROW — no lines, no postedBy; the
        // create runs without an include. Read it back for the detail.
        response: journalEntryResponseSchema,
        status: 201,
        // 400 covers both a malformed body and a refused post: an
        // unbalanced entry, an unknown or inactive account code, or a
        // closed period. The controller answers all of them the same way.
        errors: [400, 401, 403],
      }),
    },
    journal.post,
  );
  app.post<{ Params: { id: string } }>(
    "/journal/:id/reverse",
    {
      preHandler: app.requirePermission("accounting.reverse"),
      schema: routeSchema({
        summary:
          "Reverse an entry into the CURRENT period. Idempotent — a " +
          "second call returns the existing reversal.",
        tags: TAGS,
        params: journalIdParamSchema,
        /*
         * No `body` schema on purpose. The memo body is optional here
         * (`req.body ?? {}`), and attaching a schema would make Fastify
         * reject the bodyless call that works today.
         */
        response: reverseSingleResponseSchema,
        status: 201,
        // Unknown entry, an entry that is itself a reversal, and a
        // closed current period all surface as 400 from the controller.
        errors: [400, 401, 403],
      }),
    },
    journal.reverse,
  );
  /*
   * No schema on reverse-bulk. It answers 207 Multi-Status — partial
   * failure is the point — and `routeSchema` has slots for 200/201/202
   * only. Documenting it as a 200 would publish a status the route never
   * sends, which is worse than the honest blank; see the report note.
   */
  app.post(
    "/journal/reverse-bulk",
    { preHandler: app.requirePermission("accounting.reverse") },
    journal.reverseBulk,
  );

  // ─── Ledger ─────────────────────────────────────────────────────────

  app.get<{
    Params: { accountId: string };
    Querystring: { from?: string; to?: string };
  }>(
    "/ledger/:accountId",
    {
      ...read,
      schema: routeSchema({
        summary: "One account's ledger, oldest first, with running balance.",
        tags: TAGS,
        params: accountIdParamSchema,
        querystring: rangeQuerySchema,
        response: ledgerResponseSchema,
        errors: [400, ...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.ledgerFor(
        req.params.accountId,
        parseFrom(req.query.from),
        req.query.to ? parseAsOf(req.query.to) : undefined,
      ),
  );

  // ─── Reports ────────────────────────────────────────────────────────

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/trial-balance",
    {
      ...read,
      schema: routeSchema({
        summary: "Trial balance as at a date. Defaults to now.",
        tags: TAGS,
        querystring: asOfQuerySchema,
        response: trialBalanceResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.trialBalance(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/income-statement",
    {
      ...read,
      schema: routeSchema({
        summary: "Income statement over a range. `from` defaults to Jan 1.",
        tags: TAGS,
        querystring: rangeQuerySchema,
        response: incomeStatementResponseSchema,
        // Not 400. The handler has a 400 branch for an invalid `from`,
        // but `parseFrom` throws before it can be reached, so the route
        // has never actually answered one.
        errors: [...readErrors],
      }),
    },
    async (req, reply) => {
      const to = parseAsOf(req.query.to);
      const from =
        parseFrom(req.query.from) ?? new Date(to.getFullYear(), 0, 1);
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
    {
      ...read,
      schema: routeSchema({
        summary: "Balance sheet as at a date. Defaults to now.",
        tags: TAGS,
        querystring: asOfQuerySchema,
        response: balanceSheetResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.balanceSheet(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/loan-portfolio",
    {
      ...read,
      schema: routeSchema({
        summary: "Loan aging, per loan and totalled by band.",
        tags: TAGS,
        querystring: asOfQuerySchema,
        response: loanPortfolioAgingResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.loanPortfolioAging(
        parseAsOf(req.query.asOf),
      ),
  );

  app.get<{ Querystring: { asOf?: string } }>(
    "/reports/portfolio-summary",
    {
      ...read,
      schema: routeSchema({
        summary: "Portfolio snapshot: outstanding, PAR 30/60/90, NPL.",
        tags: TAGS,
        querystring: asOfQuerySchema,
        response: portfolioSummaryResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) =>
      req.accountingCtx!.accounting.portfolioSummary(parseAsOf(req.query.asOf)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/reports/originations",
    {
      ...read,
      schema: routeSchema({
        summary: "Originations by month. Range defaults to the last 12.",
        tags: TAGS,
        querystring: rangeQuerySchema,
        response: originationsResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) => {
      const to = parseAsOf(req.query.to);
      const from =
        parseFrom(req.query.from) ??
        new Date(to.getFullYear(), to.getMonth() - 11, 1);
      return req.accountingCtx!.accounting.originationsByMonth(from, to);
    },
  );

  app.get(
    "/reports/vintage",
    {
      ...read,
      schema: routeSchema({
        summary:
          "Vintage cohorts — share of each origination month now 90+ overdue.",
        tags: TAGS,
        response: vintageResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) => req.accountingCtx!.accounting.vintageCohorts(),
  );

  // ─── Periods ────────────────────────────────────────────────────────

  app.get(
    "/periods",
    {
      ...read,
      schema: routeSchema({
        summary: "Accounting periods, newest first. Capped at 60.",
        tags: TAGS,
        response: periodListResponseSchema,
        errors: [...readErrors],
      }),
    },
    async (req) => req.accountingCtx!.accounting.listPeriods(),
  );

  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/close",
    {
      preHandler: app.requirePermission("accounting.close_period"),
      schema: routeSchema({
        summary:
          "Close a period. Idempotent — closing a closed period returns it.",
        tags: TAGS,
        params: periodParamSchema,
        response: periodResponseSchema,
        errors: [400, 401, 403],
      }),
    },
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
    {
      preHandler: app.requirePermission("accounting.close_period"),
      schema: routeSchema({
        summary: "Reopen a closed period so entries can be posted into it.",
        tags: TAGS,
        params: periodParamSchema,
        response: periodResponseSchema,
        // 404 is a period that was never created — not a refusal, an
        // absence. There is nothing to reopen.
        errors: [400, 401, 403, 404],
      }),
    },
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
    {
      preHandler: app.requirePermission("accounting.accrue"),
      schema: routeSchema({
        summary:
          "Accrue interest for a period (default: this month). Idempotent.",
        tags: TAGS,
        /*
         * No `body` schema: the whole body is optional here — omitting
         * it means "the current month" — and attaching one would make
         * Fastify reject the bodyless call this route is designed for.
         */
        response: accrueResponseSchema,
        // 409 is the house meaning: the request was fine and the books
        // refused it — typically the target period is closed. Retrying
        // it unchanged will fail the same way.
        errors: [400, 401, 403, 409],
      }),
    },
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
