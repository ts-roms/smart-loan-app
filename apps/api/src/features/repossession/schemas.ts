import { z } from "zod";

/**
 * Repossession request schemas.
 *
 * The case moves through a fixed state machine:
 *   IDENTIFIED → BM_APPROVED → CREDIT_APPROVED → LEGAL_APPROVED →
 *   AGENT_ASSIGNED → RECOVERED → AUCTIONED. CANCELLED is a terminal
 *   exit any earlier stage can take.
 *
 * Each transition has its own schema; the service guards the allowed
 * state transitions (it's the repo that throws on invalid moves).
 */

export const listQuerySchema = z.object({
  status: z.string().optional(),
  loanId: z.string().uuid().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const openSchema = z.object({
  loanId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});
export type OpenInput = z.infer<typeof openSchema>;

/** Shared shape for the three approval ticks (BM / Credit / Legal). */
export const approvalSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

export const assignSchema = z.object({
  agentName: z.string().min(1).max(120),
  agentContact: z.string().min(1).max(120),
});
export type AssignInput = z.infer<typeof assignSchema>;

export const recoverSchema = z.object({
  vehicleCondition: z.string().min(1).max(500),
  vehicleMileage: z.number().int().min(0).optional(),
  vehiclePhotos: z.array(z.string().max(500)).max(20).optional(),
  storageLocation: z.string().min(1).max(200),
  outstandingAtRecovery: z.number().positive(),
});
export type RecoverInput = z.infer<typeof recoverSchema>;

export const auctionSchema = z.object({
  auctionMethod: z.string().min(1).max(40),
  auctionProceeds: z.number().nonnegative(),
});
export type AuctionInput = z.infer<typeof auctionSchema>;

export const cancelSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type CancelInput = z.infer<typeof cancelSchema>;

/* ─── Request params, for the OpenAPI spec ──────────────────────────────
 *
 * `:id` is the case uuid, but left loose on purpose: a malformed id
 * lands in a findUnique (404) or a transition (400 BadRequest) today,
 * and a `.uuid()` constraint would move both to a schema 400 with a
 * different body.
 */
export const caseIdParamSchema = z.object({
  id: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). The money rule bites on the case row: the three
 * auction columns are Prisma `Decimal` → STRINGS on the wire, while the
 * /outstanding figures and the auction verdict's deficiency/surplus are
 * folded in JS — numbers.
 */

const repossessionStatusSchema = z.enum([
  "IDENTIFIED",
  "BM_APPROVED",
  "CREDIT_HEAD_APPROVED",
  "LEGAL_APPROVED",
  "AGENT_ASSIGNED",
  "RECOVERED",
  "AUCTIONED",
  "CLOSED",
  "CANCELLED",
]);

/**
 * A repossession case as stored — every transition endpoint answers
 * this same row, with more of the nullable stage fields filled in the
 * further along the chain it is.
 */
export const caseResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  status: repossessionStatusSchema,
  reason: z.string(),
  identifiedAt: z.string().datetime(),
  identifiedById: z.string(),
  bmApprovedAt: z.string().datetime().nullable(),
  bmApprovedById: z.string().nullable(),
  bmApprovalNote: z.string().nullable(),
  creditHeadApprovedAt: z.string().datetime().nullable(),
  creditHeadApprovedById: z.string().nullable(),
  creditHeadApprovalNote: z.string().nullable(),
  legalApprovedAt: z.string().datetime().nullable(),
  legalApprovedById: z.string().nullable(),
  legalApprovalNote: z.string().nullable(),
  agentName: z.string().nullable(),
  agentContact: z.string().nullable(),
  agentAssignedAt: z.string().datetime().nullable(),
  agentAssignedById: z.string().nullable(),
  recoveredAt: z.string().datetime().nullable(),
  recoveredById: z.string().nullable(),
  vehicleCondition: z.string().nullable(),
  vehicleMileage: z.number().int().nullable(),
  storageLocation: z.string().nullable(),
  auctionedAt: z.string().datetime().nullable(),
  auctionedById: z.string().nullable(),
  auctionMethod: z.string().nullable(),
  /** Decimal on the wire — set at auction. */
  auctionProceeds: z.string().nullable(),
  /** Decimal on the wire — captured at recovery. */
  outstandingAtRecovery: z.string().nullable(),
  /** Decimal on the wire — what auction proceeds failed to cover. */
  deficiency: z.string().nullable(),
  /** The settlement entry posted at auction. */
  journalEntryId: z.string().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  cancelledById: z.string().nullable(),
  cancellationReason: z.string().nullable(),
});

/** GET /repossession — cases plus the loan reference they hang off. */
export const caseListResponseSchema = z.array(
  caseResponseSchema.extend({
    loan: z.object({
      number: z.string(),
      customerId: z.string().uuid(),
    }),
  }),
);

/**
 * GET /repossession/:id/outstanding — the figure the recover form
 * default-fills. Folded in JS: numbers.
 */
export const outstandingResponseSchema = z.object({
  outstandingPrincipal: z.number(),
  outstandingPenalties: z.number(),
  totalOutstanding: z.number(),
});

/**
 * POST /repossession/:id/auction 201 — the closed case plus the
 * settlement verdict. Exactly one of deficiency/surplus is non-zero
 * (or both are zero on a par sale).
 */
export const auctionResponseSchema = z.object({
  case: caseResponseSchema,
  journalEntryId: z.string(),
  deficiency: z.number(),
  surplus: z.number(),
});
