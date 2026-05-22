import { z } from "zod";

/**
 * ECL run request. Both period fields default in the service:
 *   periodEnd → today
 *   periodStart → first-of-month of periodEnd
 *
 * Letting the service own the defaults means a future migration to a
 * fiscal calendar (e.g. period starts on the 26th) doesn't touch the
 * wire format.
 */
export const runSchema = z.object({
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  notes: z.string().max(500).optional(),
});
export type RunInput = z.infer<typeof runSchema>;
