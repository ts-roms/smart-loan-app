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
