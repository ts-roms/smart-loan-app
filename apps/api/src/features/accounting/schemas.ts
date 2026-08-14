import { z } from "zod";

/**
 * Chart-of-accounts row. `code` is the natural key (e.g. "1010" for
 * Cash); the repo enforces uniqueness. `normalBalance` decides which
 * side of the ledger is the "increase" direction for the account.
 */
export const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
  normalBalance: z.enum(["DEBIT", "CREDIT"]),
  description: z.string().max(500).optional(),
});

export type AccountInput = z.infer<typeof accountSchema>;

/**
 * One line on a journal entry. A line never sits on both sides at once
 * — buildEntry rejects that during validation.
 */
export const lineSchema = z.object({
  accountCode: z.string().min(1),
  debit: z.number().nonnegative().default(0),
  credit: z.number().nonnegative().default(0),
  memo: z.string().max(200).optional(),
});

/**
 * Manual journal entry (`source: MANUAL`). Other sources are produced
 * by repo helpers (loan disbursement, payment, late-fee accrual, …) —
 * those use `buildEntry` internally and never come through this route.
 */
export const entrySchema = z.object({
  entryDate: z.string(),
  memo: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(2),
});

export type EntryInput = z.infer<typeof entrySchema>;

/**
 * Bulk reversal — IDs of journal entries to reverse in one call.
 *
 * `entryIds` is now `z.string().uuid()` per element. The pre-layered
 * route accepted any string and deferred the UUID check to the repo,
 * which meant a malformed input got an opaque database error instead
 * of a clean 400. The validation tightening is intentional; callers
 * sending non-UUID identifiers now see the standard zod
 * `{ error: "ValidationError", issues: [...] }` shape rather than the
 * old ad-hoc `{ error: "BadRequest", message: "…" }`.
 */
export const reverseBulkSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(200),
  memo: z.string().max(500).optional(),
});

export type ReverseBulkInput = z.infer<typeof reverseBulkSchema>;

/** Single-entry reversal body — memo only (id comes from the URL). */
export const reverseSingleSchema = z.object({
  memo: z.string().max(500).optional(),
});

export type ReverseSingleInput = z.infer<typeof reverseSingleSchema>;

/* ─── Request params + query, for the OpenAPI spec ──────────────────────
 *
 * Attaching these makes Fastify VALIDATE them — there is no
 * documentation-only slot. So they are written to accept exactly what
 * the handlers accept today and nothing narrower, which is why several
 * of them look looser than the field's "real" type.
 */

/**
 * `:id` on the journal routes. Deliberately NOT `.uuid()`:
 * `findEntryByIdOrNumber` accepts the human number too, so
 * `/journal/JE-2026-000016` is a supported call and a uuid constraint
 * would start rejecting the form the operator UI actually navigates by.
 */
export const journalIdParamSchema = z.object({
  id: z.string().min(1),
});

export const accountIdParamSchema = z.object({
  accountId: z.string().uuid(),
});

/**
 * Year/month as they arrive — path segments, i.e. strings.
 *
 * Not coerced to numbers: Fastify's ajv coerces on a numeric schema and
 * would answer a bad month with its own 400 body, replacing the
 * handler's `{ error: "BadRequest", message: "Invalid year/month" }`
 * that callers already read. The handler still range-checks 1..12.
 */
export const periodParamSchema = z.object({
  year: z.string(),
  month: z.string(),
});

/**
 * Report/report-range dates. `z.string()`, never `z.coerce.date()`.
 *
 * A date-only "2026-08-07" is the normal call here — `parseAsOf` widens
 * it to end-of-day on purpose (see accounting.routes.ts). Emitting
 * `format: date-time` would make Fastify reject exactly that shape
 * before the handler ever saw it.
 */
export const journalQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  /** A `JournalSource` value; unknown sources simply match nothing. */
  source: z.string().optional(),
});

export const rangeQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const asOfQuerySchema = z.object({
  asOf: z.string().optional(),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod rather than hand-written JSON Schema so they are real parsers: a
 * test can assert an actual payload against one, which is the only thing
 * that stops a published schema from quietly becoming fiction.
 *
 * They describe what is CONTRACTUAL, not everything a row happens to
 * carry — see lib/openapi.ts on why undeclared fields pass through. Two
 * house rules follow from Fastify's serialiser and are load-bearing:
 *
 *   • A field declared without `.optional()` MUST be present on every
 *     payload the route can return. fast-json-stringify throws on a
 *     missing required property, which turns a 200 into a 500.
 *   • A field's declared TYPE is applied, not merely published. Money
 *     columns are Prisma `Decimal` and reach the wire as strings; saying
 *     `z.number()` would rewrite the wire format for every consumer.
 */

const accountTypeSchema = z.enum([
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
]);

export const accountResponseSchema = z.object({
  id: z.string().uuid(),
  /** Natural key, e.g. "1010". Sorts lexically in standard order. */
  code: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  normalBalance: z.enum(["DEBIT", "CREDIT"]),
  description: z.string().nullable(),
  active: z.boolean(),
  /** Referenced by code from auto-posting; may be deactivated, not deleted. */
  system: z.boolean(),
});

export const accountListResponseSchema = z.array(accountResponseSchema);

export const seedChartResponseSchema = z.object({
  created: z.number().int(),
  existing: z.number().int(),
});

/**
 * One posted line.
 *
 * `debit`/`credit` are STRINGS. They are `NUMERIC(14,2)` in Postgres and
 * Prisma hands back a `Decimal`, which serialises as its exact decimal
 * string — "4727.98", "0". Declaring them numeric would make Fastify's
 * serialiser coerce them, silently changing the wire format every
 * existing consumer parses and putting money back through a float.
 */
const journalLineResponseSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  accountId: z.string().uuid(),
  debit: z.string(),
  credit: z.string(),
  memo: z.string().nullable(),
  account: accountResponseSchema,
});

/**
 * A journal entry row on its own — what the WRITE paths return.
 *
 * Separate from the detail shape below because `postEntry` creates
 * without an `include`, so the 201 body carries no `lines` and no
 * `postedBy`. Declaring them here would make the serialiser throw on a
 * required property that route never sends.
 */
export const journalEntryResponseSchema = z.object({
  id: z.string().uuid(),
  /** "JE-2026-000123". Accepted in place of the id on GET /journal/:id. */
  number: z.string(),
  entryDate: z.string().datetime(),
  memo: z.string().nullable(),
  source: z.string(),
  /** What produced it — "LoanPayment", "JournalEntry", … */
  sourceRefType: z.string().nullable(),
  sourceRefId: z.string().nullable(),
  postedAt: z.string().datetime(),
  postedById: z.string().uuid(),
  /** Null on entries that pre-date the periods table. */
  periodId: z.string().uuid().nullable(),
  /** Set once reversed; points at the reversing entry. */
  reversedById: z.string().uuid().nullable(),
});

/** The read shape — entry plus its lines and who posted it. */
export const journalEntryDetailResponseSchema =
  journalEntryResponseSchema.extend({
    lines: z.array(journalLineResponseSchema),
    postedBy: z.object({ id: z.string().uuid(), name: z.string() }),
  });

export const journalEntryListResponseSchema = z.array(
  journalEntryDetailResponseSchema,
);

/**
 * Single reversal outcome. `alreadyReversed` is the honest answer to a
 * repeat call: the reversal in the body is the one that already existed,
 * and no second entry was posted.
 */
export const reverseSingleResponseSchema = z.object({
  /** The id of the entry that was reversed. */
  original: z.string().uuid(),
  reversal: journalEntryResponseSchema,
  alreadyReversed: z.boolean(),
});

/** One ledger row, with the balance carried forward through the range. */
export const ledgerRowResponseSchema = z.object({
  lineId: z.string().uuid(),
  entryId: z.string().uuid(),
  entryNumber: z.string(),
  entryDate: z.string().datetime(),
  source: z.string(),
  /** Line memo, falling back to the entry's, falling back to "". */
  memo: z.string(),
  debit: z.number(),
  credit: z.number(),
  runningBalance: z.number(),
});

export const ledgerResponseSchema = z.array(ledgerRowResponseSchema);

export const trialBalanceResponseSchema = z.object({
  asOf: z.string().datetime(),
  rows: z.array(
    z.object({
      accountId: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      type: accountTypeSchema,
      /** Each account lands on its normal side; the other side is 0. */
      debit: z.number(),
      credit: z.number(),
    }),
  ),
  totalDebit: z.number(),
  totalCredit: z.number(),
  /** False means the books do not tie — treat the report as suspect. */
  inBalance: z.boolean(),
});

const statementSectionSchema = z.object({
  rows: z.array(
    z.object({ code: z.string(), name: z.string(), amount: z.number() }),
  ),
  total: z.number(),
});

export const incomeStatementResponseSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  income: statementSectionSchema,
  expense: statementSectionSchema,
  netIncome: z.number(),
});

export const balanceSheetResponseSchema = z.object({
  asOf: z.string().datetime(),
  assets: statementSectionSchema,
  liabilities: statementSectionSchema,
  equity: statementSectionSchema,
  /** Lifetime income minus expenses, folded into equity. */
  retainedEarnings: z.number(),
  totalLiabilitiesAndEquity: z.number(),
  inBalance: z.boolean(),
});

/**
 * Seven aging bands, not five. `D_90_PLUS` used to put a loan 95 days
 * late in the same row as one three years gone; they provision
 * differently and a report that cannot tell them apart supports neither
 * decision. 90 days is still a boundary, so the non-performing line
 * reads straight off the report.
 */
const agingBucketSchema = z.enum([
  "CURRENT",
  "D_1_30",
  "D_31_60",
  "D_61_90",
  "D_91_120",
  "D_121_180",
  "D_180_PLUS",
]);

export const loanPortfolioAgingResponseSchema = z.object({
  asOf: z.string().datetime(),
  rows: z.array(
    z.object({
      loanId: z.string().uuid(),
      loanNumber: z.string(),
      customerName: z.string(),
      /** Unpaid installments already past their due date. */
      installmentsOverdue: z.number().int(),
      outstandingBalance: z.number(),
      bucket: agingBucketSchema,
      /** Days the EARLIEST unpaid installment is past due; 0 if current. */
      daysOverdue: z.number().int(),
    }),
  ),
  /** Every band is always present, including the ones summing to zero. */
  totals: z.object({
    CURRENT: z.number(),
    D_1_30: z.number(),
    D_31_60: z.number(),
    D_61_90: z.number(),
    D_91_120: z.number(),
    D_121_180: z.number(),
    D_180_PLUS: z.number(),
  }),
  totalOutstanding: z.number(),
});

export const portfolioSummaryResponseSchema = z.object({
  asOf: z.string().datetime(),
  activeLoans: z.number().int(),
  totalOutstanding: z.number(),
  originatedYtd: z.object({
    count: z.number().int(),
    principal: z.number(),
  }),
  /** Portfolio at risk: balance on loans overdue past 30/60/90 days. */
  par30: z.number(),
  par60: z.number(),
  par90: z.number(),
  /** par90 / totalOutstanding, or 0 when there is nothing outstanding. */
  nplRatio: z.number(),
  cash: z.number(),
  receivable: z.number(),
});

export const originationsResponseSchema = z.array(
  z.object({
    /** "2026-08" — calendar month of submission. */
    month: z.string(),
    count: z.number().int(),
    principal: z.number(),
  }),
);

export const vintageResponseSchema = z.array(
  z.object({
    /** "2026-08" — the cohort's origination month. */
    vintage: z.string(),
    originated: z.number().int(),
    currentlyOverdue90Plus: z.number().int(),
    defaultRate: z.number(),
  }),
);

export const periodResponseSchema = z.object({
  id: z.string().uuid(),
  year: z.number().int(),
  month: z.number().int(),
  status: z.enum(["OPEN", "CLOSED"]),
  closedAt: z.string().datetime().nullable(),
  closedById: z.string().uuid().nullable(),
});

export const periodListResponseSchema = z.array(periodResponseSchema);

/** Idempotent accrual: `posted` is new entries, `skipped` is everything else. */
export const accrueResponseSchema = z.object({
  posted: z.number().int(),
  skipped: z.number().int(),
});

/**
 * Bulk reversal, reported per entry — the body of a **207 Multi-Status**.
 *
 * 207 because partial failure is the normal outcome here rather than an
 * edge case: a batch of twenty entries where three are already reversed
 * and one sits in a closed period succeeds sixteen times and fails four,
 * in a single call. A 200 would say the whole batch landed and a 400
 * would say none of it did; both are wrong most of the time.
 *
 * `succeeded`/`failed` are the counts a UI puts in a toast. `results`
 * is what makes the call actionable — it says which entry got which
 * answer, so an operator can retry exactly the ones that did not land
 * instead of re-submitting the batch and double-reversing the rest.
 *
 * `reversalId`/`reversalNumber` appear only on a row that succeeded and
 * `error` only on one that did not, so all three are optional rather
 * than nullable — the handler omits them rather than sending null.
 * `reversalNumber` is declared even though today's repository never
 * populates it: the service's row type carries it, and an undeclared
 * field would be silently stripped on the day it starts being set.
 */
export const reverseBulkResponseSchema = z.object({
  results: z.array(
    z.object({
      entryId: z.string().uuid(),
      ok: z.boolean(),
      reversalId: z.string().uuid().optional(),
      reversalNumber: z.string().optional(),
      /** The refusal, verbatim, when `ok` is false. */
      error: z.string().optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
