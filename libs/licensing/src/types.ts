/**
 * License payload — the JSON body that gets signed and shipped to a
 * tenant. The token a customer pastes into /settings/license is the
 * base64url-encoded payload concatenated with an Ed25519 signature.
 *
 * Keep this stable. Any breaking change requires a `v` bump so older
 * tokens can be rejected explicitly instead of silently mis-parsed.
 */

/** Format version. Bump when fields change incompatibly. */
export const LICENSE_FORMAT_VERSION = 1;

/** Token prefix — eye-catching, helps users not mistake the token for some other secret. */
export const LICENSE_TOKEN_PREFIX = "SMARTLOAN-LIC-v1";

/**
 * Tier defines the bundle of features unlocked. Order matters: each
 * tier is a strict superset of the previous one. Use the helpers in
 * `./features.ts` rather than reading this directly.
 */
export const LICENSE_TIERS = ["BASIC", "PROFESSIONAL", "ENTERPRISE"] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

/**
 * Feature flags the license can gate. Routes consult these via
 * `app.requireFeature(...)` (Phase 1b). Add new flags here as features
 * ship; the default catalog in `./features.ts` decides which tier
 * unlocks which flag.
 */
export const FEATURE_FLAGS = [
  // Core
  "core.customers",
  "core.loans",
  "core.kyc",
  "core.scoring",
  // Servicing
  "servicing.collections",
  "servicing.demand_letters",
  "servicing.repossession",
  "servicing.lease",
  // Accounting
  "accounting.gl",
  "accounting.periods",
  "accounting.ecl",
  "accounting.reconciliation",
  // Cooperative
  "cooperative.contributions",
  "cooperative.savings",
  "cooperative.funds",
  // Compliance
  "compliance.dorsi",
  "compliance.annual_docs",
  "compliance.reports",
  // Intelligence (the FRD "differentiators")
  "intel.ai_assistant",
  "intel.id_ocr",
  "intel.face_match",
  "intel.anomaly_flags",
  // Bulk / scale
  "bulk.customers",
  "bulk.users",
  "bulk.payments",
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/**
 * The signed payload. The signature lives outside this object — the
 * full wire token is `${prefix}.${base64url(json(payload))}.${base64url(signature)}`.
 *
 * Fields:
 *   - `v`            format version (always {@link LICENSE_FORMAT_VERSION} today)
 *   - `jti`          unique license id (UUID) — lets the platform revoke a specific issue
 *   - `tenant`       human-readable tenant name (cooperative / lender name)
 *   - `tier`         {@link LicenseTier}
 *   - `features`     explicit feature-flag list. The CLI fills this from the tier default
 *                    catalog, but issuers can override per-license (e.g. ENTERPRISE without AI)
 *   - `iat`          issued-at unix ms
 *   - `nbf`          not-before unix ms — license inactive before this instant (optional;
 *                    defaults to iat at issue time)
 *   - `exp`          expiry unix ms — license inactive after this instant
 *   - `seats`        soft cap on active staff users (Phase 1b enforcement). 0 = unlimited.
 *   - `notes`        free-form description shown on /settings/license (optional)
 */
export interface LicensePayload {
  v: typeof LICENSE_FORMAT_VERSION;
  jti: string;
  tenant: string;
  tier: LicenseTier;
  features: FeatureFlag[];
  iat: number;
  nbf?: number;
  exp: number;
  seats: number;
  notes?: string;
}

/** Result of `verifyLicense`. Discriminated union — narrow on `ok`. */
export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | {
      ok: false;
      kind:
        | "MalformedToken"
        | "WrongVersion"
        | "BadSignature"
        | "Expired"
        | "NotYetActive"
        | "InvalidPayload";
      message: string;
    };
