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

/**
 * The licence status payload — one object with two shapes.
 *
 * `status` is the discriminator and the only field that is always
 * present. When it is ACTIVE the licence details come with it; when it
 * is anything else (EXPIRED / TAMPERED / NONE / NO_KEY) the payload is
 * just the status and a human `message`, because there is no valid
 * licence to describe.
 *
 * Written as ONE object with optional fields rather than a `z.union`.
 * A union emits `anyOf`, and Fastify serialises responses against the
 * schema — `anyOf` makes fast-json-stringify pick a branch by guessing,
 * and the branch it picks decides which of your fields survive. One
 * permissive object cannot mis-pick. The cost is that the spec does not
 * enforce "ACTIVE implies tier", which a reader gets from this note
 * instead.
 *
 * Note also that the absent fields are OMITTED, not null — the builder
 * only assigns them on the ACTIVE path — hence `.optional()` throughout
 * rather than `.nullable()`.
 */
export const licenseStatusResponseSchema = z.object({
  status: z.enum(["ACTIVE", "EXPIRED", "TAMPERED", "NONE", "NO_KEY"]),
  /** Present on every non-ACTIVE status; explains what is wrong. */
  message: z.string().optional(),
  /** Tenant slug the licence was issued to. ACTIVE only, as are the rest. */
  tenant: z.string().optional(),
  tier: z.enum(["BASIC", "PROFESSIONAL", "ENTERPRISE"]).optional(),
  /** Feature flags this licence grants; `requireFeature` reads these. */
  features: z.array(z.string()).optional(),
  /** 0 means unlimited. */
  seats: z.number().int().optional(),
  issuedAt: z.string().datetime().optional(),
  /** Omitted when the licence carries no `nbf`. */
  notBefore: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().optional(),
  /** Negative once expired — the banner counts down and then up. */
  daysUntilExpiry: z.number().int().optional(),
});

/**
 * `POST /license/deactivate` — idempotent.
 *
 * `revokedId` is null when there was nothing active to revoke, which is
 * a success rather than a 404: the caller asked for "no active licence"
 * and that is the state they got.
 */
export const deactivateLicenseResponseSchema = z.object({
  ok: z.boolean(),
  revokedId: z.string().nullable(),
});
