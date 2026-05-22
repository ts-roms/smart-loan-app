import { z } from "zod";

/**
 * Wire schema for POST /license/activate. We only validate basic shape
 * here; the cryptographic verification lives in the service (it needs
 * the loaded public key, which the route layer shouldn't see).
 */
export const activateLicenseSchema = z.object({
  token: z.string().min(1).max(8_000),
});
export type ActivateLicenseInput = z.infer<typeof activateLicenseSchema>;
