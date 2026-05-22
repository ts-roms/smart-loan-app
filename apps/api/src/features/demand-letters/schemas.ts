import { z } from "zod";

/**
 * Demand Letter schemas — FRD §3.6.
 *
 * Stage ladder: FIRST (60d) → FINAL (90d) → ATTORNEY_FIRST → ATTORNEY_FINAL.
 * Status ladder: DRAFTED → APPROVED → DISPATCHED → (RESPONDED | WAIVED).
 *
 * Approval permissions and segregation-of-duties checks live in the
 * service — the schemas here are the wire-format only.
 */

export const stageEnum = z.enum([
  "FIRST",
  "FINAL",
  "ATTORNEY_FIRST",
  "ATTORNEY_FINAL",
]);
export type DemandLetterStageEnum = z.infer<typeof stageEnum>;

export const statusEnum = z.enum([
  "DRAFTED",
  "APPROVED",
  "DISPATCHED",
  "RESPONDED",
  "WAIVED",
]);
export type DemandLetterStatusEnum = z.infer<typeof statusEnum>;

export const candidatesQuerySchema = z.object({
  stage: stageEnum,
});
export type CandidatesQuery = z.infer<typeof candidatesQuerySchema>;

export const listQuerySchema = z.object({
  stage: stageEnum.optional(),
  status: statusEnum.optional(),
  loanId: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const batchSchema = z.object({
  loanIds: z.array(z.string().uuid()).min(1).max(200),
  stage: stageEnum,
  paymentDeadlineDays: z.number().int().min(1).max(60).optional(),
});
export type BatchInput = z.infer<typeof batchSchema>;

export const approveSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ApproveInput = z.infer<typeof approveSchema>;

export const dispatchSchema = z.object({
  channel: z.string().min(1).max(40),
  ref: z.string().max(120).optional(),
});
export type DispatchInput = z.infer<typeof dispatchSchema>;

export const closeSchema = z.object({
  status: z.enum(["RESPONDED", "WAIVED"]),
  reason: z.string().min(3).max(500),
});
export type CloseInput = z.infer<typeof closeSchema>;
