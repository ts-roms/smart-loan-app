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
