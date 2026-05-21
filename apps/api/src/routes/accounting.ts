import { AccountingRepository, AuditLogRepository } from "@loan/db";
import { buildEntry } from "@loan/accounting";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
  normalBalance: z.enum(["DEBIT", "CREDIT"]),
  description: z.string().max(500).optional(),
});

const lineSchema = z.object({
  accountCode: z.string().min(1),
  debit: z.number().nonnegative().default(0),
  credit: z.number().nonnegative().default(0),
  memo: z.string().max(200).optional(),
});

const entrySchema = z.object({
  entryDate: z.string(),
  memo: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(2),
});

function parseAsOf(value: string | undefined): Date {
  if (!value) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  return d;
}

export async function accountingRoutes(app: FastifyInstance) {
  const accounting = new AccountingRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

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

  /** Manual journal entry. ACCOUNTANT+ only. */
  app.post(
    "/journal",
    { preHandler: app.requirePermission("accounting.post_journal") },
    async (req, reply) => {
      const parsed = entrySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const validated = buildEntry({
          entryDate: new Date(parsed.data.entryDate),
          memo: parsed.data.memo,
          source: "MANUAL",
          lines: parsed.data.lines,
        });
        const entry = await accounting.postEntry(validated, {
          postedById: req.user.sub,
        });
        return reply.code(201).send(entry);
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: err instanceof Error ? err.message : "Invalid entry",
        });
      }
    },
  );

  /** Reverse a single entry (ACCOUNTANT+). Audit-logged. */
  app.post<{ Params: { id: string }; Body?: { memo?: string } }>(
    "/journal/:id/reverse",
    { preHandler: app.requirePermission("accounting.reverse") },
    async (req, reply) => {
      try {
        const result = await accounting.reverseEntry(req.params.id, {
          postedById: req.user.sub,
          memo: req.body?.memo,
        });
        await audit.record({
          action: "JOURNAL_REVERSE",
          actorId: req.user.sub,
          targetType: "JournalEntry",
          targetId: req.params.id,
          payload: {
            reversalId: result.reversal.id,
            reversalNumber: result.reversal.number,
            created: result.created,
            memo: req.body?.memo,
          },
        });
        return reply.code(201).send({
          original: result.original.id,
          reversal: result.reversal,
          alreadyReversed: !result.created,
        });
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  /** Reverse many entries at once. Per-entry status returned (HTTP 207). */
  app.post<{ Body: { entryIds: string[]; memo?: string } }>(
    "/journal/reverse-bulk",
    { preHandler: app.requirePermission("accounting.reverse") },
    async (req, reply) => {
      const ids = req.body?.entryIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
        return reply.code(400).send({
          error: "BadRequest",
          message: "entryIds must be a non-empty array of ≤200 IDs",
        });
      }
      const results = await accounting.reverseEntriesBulk(ids, {
        postedById: req.user.sub,
        memoTemplate: req.body?.memo,
      });
      const succeeded = results.filter((r) => r.ok).length;
      await audit.record({
        action: "JOURNAL_REVERSE_BULK",
        actorId: req.user.sub,
        payload: {
          requested: ids.length,
          succeeded,
          failed: ids.length - succeeded,
          memo: req.body?.memo,
          results,
        },
      });
      return reply.code(207).send({
        results,
        succeeded,
        failed: ids.length - succeeded,
      });
    },
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
