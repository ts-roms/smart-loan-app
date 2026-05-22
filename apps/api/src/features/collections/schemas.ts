import { z } from "zod";

/**
 * Collections request shapes. Notes capture interactions with the
 * borrower (call/SMS/email/visit); promises-to-pay (PTPs) are
 * lightweight forecasts the borrower commits to. Resolution updates
 * the PTP's terminal state.
 */

export const noteSchema = z.object({
  type: z.enum(["CALL", "SMS", "EMAIL", "VISIT", "OTHER"]).default("OTHER"),
  body: z.string().min(1).max(2000),
});
export type NoteInput = z.infer<typeof noteSchema>;

export const ptpSchema = z.object({
  amount: z.number().positive(),
  promisedDate: z.string(),
  note: z.string().max(500).optional(),
});
export type PtpInput = z.infer<typeof ptpSchema>;

export const resolveSchema = z.object({
  status: z.enum(["HONORED", "BROKEN", "CANCELLED"]),
});
export type ResolveInput = z.infer<typeof resolveSchema>;
