import { z } from "zod";

/**
 * Cooperative module wire schemas. Seven entity types under the
 * `/cooperative/*` namespace, every mutation auto-posts to the GL via
 * the CooperativeRepository — see
 * libs/db/src/repositories/cooperative.repository.ts.
 *
 * Date fields are accepted as ISO strings here; the service coerces
 * to `Date` before handing off to the repo (Prisma rejects unparsed
 * strings on DateTime columns).
 */

export const contributionSchema = z.object({
  customerId: z.string().uuid(),
  capitalBuildUp: z.number().nonnegative().default(0),
  mortuaryFund: z.number().nonnegative().default(0),
  emergencyFund: z.number().nonnegative().default(0),
  notes: z.string().max(500).optional(),
  contributedAt: z.string().optional(),
});
export type ContributionInput = z.infer<typeof contributionSchema>;

export const savingsSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().positive(),
  kind: z.enum(["DEPOSIT", "WITHDRAWAL"]).default("DEPOSIT"),
  notes: z.string().max(500).optional(),
  txnDate: z.string().optional(),
});
export type SavingsInput = z.infer<typeof savingsSchema>;

/** Capital injection into the fund — from a member or a 3rd-party. */
export const fundTxnSchema = z.object({
  customerId: z.string().uuid().optional(),
  transactionRef: z.string().max(120).optional(),
  sourceOfFunds: z.string().min(1).max(60),
  amount: z.number().positive(),
  txnDate: z.string().optional(),
  notes: z.string().max(500).optional(),
});
export type FundTxnInput = z.infer<typeof fundTxnSchema>;

/** Capital outflow — counterpart to a fund txn. */
export const withdrawalSchema = z.object({
  customerId: z.string().uuid().optional(),
  sourceOfFunds: z.string().min(1).max(60),
  amount: z.number().positive(),
  notes: z.string().max(500).optional(),
  txnDate: z.string().optional(),
});
export type WithdrawalInput = z.infer<typeof withdrawalSchema>;

export const expenseSchema = z.object({
  type: z.string().min(1).max(120),
  amount: z.number().positive(),
  sourceOfFunds: z.string().min(1).max(60),
  txnDate: z.string().optional(),
  isRecurring: z.boolean().optional(),
  attachments: z.array(z.string().max(500)).max(20).optional(),
  notes: z.string().max(500).optional(),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const otherIncomeSchema = z.object({
  type: z.string().min(1).max(120),
  amount: z.number().positive(),
  sourceTo: z.string().min(1).max(60),
  txnDate: z.string().optional(),
  attachments: z.array(z.string().max(500)).max(20).optional(),
  notes: z.string().max(500).optional(),
});
export type OtherIncomeInput = z.infer<typeof otherIncomeSchema>;

/** External capital (often inter-coop or NGO-backed); has a duration. */
export const bigBrotherSchema = z.object({
  name: z.string().min(1).max(120),
  account: z.string().min(1).max(120),
  capital: z.number().positive(),
  periodFrom: z.string(),
  periodTo: z.string(),
  notes: z.string().max(500).optional(),
});
export type BigBrotherInput = z.infer<typeof bigBrotherSchema>;
