import { z } from "zod";

/** One transaction line from a bank statement import. */
export const lineInputSchema = z.object({
  txnDate: z.string(),
  description: z.string().min(1).max(500),
  amount: z.number(),
  reference: z.string().max(120).optional(),
  runningBalance: z.number().optional(),
});

export type LineInput = z.infer<typeof lineInputSchema>;

/**
 * Create a new bank statement + its lines in one shot. Up to 5,000
 * lines per call — a real cooperative bank statement is rarely more
 * than a few hundred lines, but the upper bound protects against
 * accidental wholesale uploads.
 */
export const statementSchema = z.object({
  label: z.string().min(1).max(120),
  bankAccount: z.string().min(1).max(120),
  periodStart: z.string(),
  periodEnd: z.string(),
  openingBalance: z.number(),
  closingBalance: z.number(),
  lines: z.array(lineInputSchema).min(1).max(5000),
});

export type StatementInput = z.infer<typeof statementSchema>;

/**
 * Manual match — operator pins a bank-line to an internal record
 * (LoanPayment, JournalEntry, …) when the auto-matcher couldn't.
 */
export const manualMatchSchema = z.object({
  type: z.string().min(1).max(40),
  refId: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
});

export type ManualMatchInput = z.infer<typeof manualMatchSchema>;

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 *
 * The money rule earns its keep in this feature more than most. Every
 * balance and line amount is a Prisma `Decimal` and therefore a STRING
 * on the wire — `openingBalance`, `closingBalance`, `amount`,
 * `runningBalance`. The REQUEST schemas above take the same fields as
 * `z.number()`, which is correct and is not a contradiction: a caller
 * posts JSON numbers, Postgres stores `Decimal(18,2)`, and what comes
 * back out is a string. Declaring the response side as numbers would
 * make the spec disagree with every payload the route sends.
 *
 * The exception is the two AGGREGATE endpoints — `/summary` and
 * `auto-match` — whose figures are folded in JS with `Number(...)` and
 * so really are numbers. Same feature, both conventions, deliberately.
 */

/** `:id` on the statement routes. */
export const statementIdParamSchema = z.object({ id: z.string().uuid() });

/** `:id` on the line routes — a BankStatementLine, not a statement. */
export const lineIdParamSchema = z.object({ id: z.string().uuid() });

/** How far along a statement's reconciliation is. */
const statementStatusSchema = z.enum(["IMPORTED", "RECONCILED", "ARCHIVED"]);

/**
 * A bank statement header, without its lines — what `list` and `create`
 * both answer.
 */
export const statementResponseSchema = z.object({
  id: z.string().uuid(),
  /** Operator-chosen, e.g. "BPI-Current-202605". */
  label: z.string(),
  bankAccount: z.string(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  /** Decimal on the wire — the bank's reported opening balance. */
  openingBalance: z.string(),
  /** Decimal on the wire — the bank's reported closing balance. */
  closingBalance: z.string(),
  importedById: z.string().nullable(),
  importedAt: z.string().datetime(),
  status: statementStatusSchema,
});

export const statementListResponseSchema = z.array(statementResponseSchema);

/**
 * One imported transaction line, plus wherever the reconciler put it.
 * The five `matched*` fields are all null until something claims the
 * line and all non-null afterwards — `/match` and `/unmatch` are the
 * two ends of that, and both answer this shape.
 */
export const lineResponseSchema = z.object({
  id: z.string().uuid(),
  statementId: z.string().uuid(),
  txnDate: z.string().datetime(),
  description: z.string(),
  /** Decimal on the wire. Positive = credit (in), negative = debit (out). */
  amount: z.string(),
  reference: z.string().nullable(),
  /** Decimal on the wire, when the bank's CSV carried one. */
  runningBalance: z.string().nullable(),
  /** "LoanPayment", "LoanDisbursement", or a free-text kind like "MANUAL". */
  matchedType: z.string().nullable(),
  matchedRefId: z.string().nullable(),
  matchedAt: z.string().datetime().nullable(),
  matchedById: z.string().nullable(),
  matchNote: z.string().nullable(),
});

/** GET /statements/:id — the header with every line, oldest first. */
export const statementDetailResponseSchema = statementResponseSchema.extend({
  lines: z.array(lineResponseSchema),
});

/**
 * GET /statements/:id/summary — the dashboard counters. Folded in JS
 * from the line amounts, so these are real numbers rather than the
 * Decimal strings the lines themselves carry.
 */
export const summaryResponseSchema = z.object({
  totalLines: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  matchedAmount: z.number(),
  unmatchedAmount: z.number(),
});

/**
 * POST /statements/:id/auto-match — what the pass achieved, plus a
 * per-line verdict so the UI can say which lines it left alone.
 * `details` has an entry for EVERY line considered, matched or not; an
 * unmatched one carries nulls rather than being omitted.
 */
export const autoMatchResponseSchema = z.object({
  matchedLines: z.number().int(),
  /** Folded in JS — a number, unlike the per-line Decimal amounts. */
  matchedAmount: z.number(),
  details: z.array(
    z.object({
      lineId: z.string().uuid(),
      matchedType: z.string().nullable(),
      matchedRefId: z.string().nullable(),
      note: z.string().optional(),
    }),
  ),
});

/**
 * GET /lines/:id/candidates — scored suggestions for the match drawer,
 * best first. Empty when the line does not exist, which is deliberate:
 * the route answers `[]` rather than 404 (see the routes file).
 */
export const candidateListResponseSchema = z.array(
  z.object({
    type: z.enum(["LoanPayment", "LoanDisbursement"]),
    refId: z.string().uuid(),
    /** 0..1 confidence. 1.0 = amount and reference both matched exactly. */
    score: z.number(),
    /** Human label for the drawer row, e.g. "Payment on LN-2026-000123". */
    label: z.string(),
    /** Second line of the drawer row — date and reference, or principal. */
    detail: z.string(),
  }),
);
