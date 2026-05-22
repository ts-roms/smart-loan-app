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

/** Bulk reversal — IDs of journal entries to reverse in one call. */
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
