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

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against. They
 * name what is CONTRACTUAL; undeclared columns pass through (see
 * lib/openapi.ts). The rule that bites here: every money column is a
 * Prisma `Decimal` and reaches the wire as a STRING ("1500.00"), while
 * the create REQUESTS take numbers — the asymmetry is real and an
 * integrator assuming symmetry gets text where they sent a number.
 * The member-ledger `totals` are folded in JS and really are numbers.
 */

/** A contribution row as stored. All three fund columns are Decimal strings. */
export const contributionResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  /** Decimal on the wire — e.g. "500". */
  capitalBuildUp: z.string(),
  mortuaryFund: z.string(),
  emergencyFund: z.string(),
  notes: z.string().nullable(),
  contributedAt: z.string().datetime(),
  recordedById: z.string().nullable(),
  /** The GL entry that booked it. Null = posting deferred. */
  journalEntryId: z.string().nullable(),
});

export const savingsTransactionResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  kind: z.enum(["DEPOSIT", "WITHDRAWAL"]),
  /** Decimal on the wire. */
  amount: z.string(),
  notes: z.string().nullable(),
  txnDate: z.string().datetime(),
  recordedById: z.string().nullable(),
  journalEntryId: z.string().nullable(),
});

export const fundTransactionResponseSchema = z.object({
  id: z.string().uuid(),
  /** Null on inflows that are not member-attributable. */
  customerId: z.string().uuid().nullable(),
  transactionRef: z.string().nullable(),
  sourceOfFunds: z.string(),
  /** Decimal on the wire. */
  amount: z.string(),
  txnDate: z.string().datetime(),
  authorId: z.string().nullable(),
  notes: z.string().nullable(),
  journalEntryId: z.string().nullable(),
});

export const fundWithdrawalResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  sourceOfFunds: z.string(),
  /** Decimal on the wire. */
  amount: z.string(),
  notes: z.string().nullable(),
  txnDate: z.string().datetime(),
  authorId: z.string().nullable(),
  journalEntryId: z.string().nullable(),
});

export const expenseResponseSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  /** Decimal on the wire. */
  amount: z.string(),
  sourceOfFunds: z.string(),
  txnDate: z.string().datetime(),
  isRecurring: z.boolean(),
  /** Receipt / invoice URLs. */
  attachments: z.array(z.string()),
  notes: z.string().nullable(),
  recordedById: z.string().nullable(),
  journalEntryId: z.string().nullable(),
});

export const otherIncomeResponseSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  /** Decimal on the wire. */
  amount: z.string(),
  /** Which fund the income credits — same string buckets as Funds. */
  sourceTo: z.string(),
  txnDate: z.string().datetime(),
  attachments: z.array(z.string()),
  notes: z.string().nullable(),
  recordedById: z.string().nullable(),
  journalEntryId: z.string().nullable(),
});

export const bigBrotherResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  account: z.string(),
  /** Decimal on the wire. */
  capital: z.string(),
  periodFrom: z.string().datetime(),
  periodTo: z.string().datetime(),
  notes: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
});

/**
 * GET /cooperative/members/:customerId/ledger — also the shape behind
 * the borrower's own GET /portal/member-ledger. The `totals` roll up
 * across ALL rows (folded in JS — numbers); the two `recent*` arrays
 * carry the latest 20 stored rows each, Decimal strings and all.
 */
export const memberLedgerResponseSchema = z.object({
  customer: z.object({
    id: z.string().uuid(),
    number: z.string(),
    firstName: z.string(),
    middleName: z.string().nullable(),
    lastName: z.string(),
    email: z.string().nullable(),
    phone: z.string(),
    governmentIdType: z.string(),
    governmentIdNumber: z.string(),
  }),
  totals: z.object({
    capitalBuildUp: z.number(),
    mortuaryFund: z.number(),
    emergencyFund: z.number(),
    contributionsCount: z.number().int(),
    /** Deposits minus withdrawals, across all rows. */
    savingsNet: z.number(),
    savingsDeposits: z.number(),
    savingsWithdrawals: z.number(),
    depositCount: z.number().int(),
    withdrawalCount: z.number().int(),
  }),
  recentContributions: z.array(contributionResponseSchema),
  recentSavings: z.array(savingsTransactionResponseSchema),
});

/**
 * `:customerId` — deliberately NOT `.uuid()`. The lookup is a findUnique
 * that answers 404 on any miss today, malformed ids included; tightening
 * the param would change which status a bad id receives.
 */
export const memberLedgerParamSchema = z.object({
  customerId: z.string().min(1),
});
