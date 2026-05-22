-- Phase 3 hardening — platform-side record of every license issued.
--
-- Mirror of the tenant-side `License` table (which tracks activations
-- on a tenant instance). This one tracks issuances on the vendor's
-- control plane so the platform console can:
--
--   * Show full license history per tenant (without scanning audit
--     payloads).
--   * Mark a license as revoked (platform-side; tokens themselves stay
--     valid until `expiresAt` unless we add a CRL endpoint).
--   * Re-send a token to the tenant admin without re-issuance.

CREATE TABLE "PlatformIssuedLicense" (
  "id"            TEXT NOT NULL,
  "jti"           TEXT NOT NULL,
  "tenantSlug"    TEXT NOT NULL,
  "tenantName"    TEXT NOT NULL,
  "tier"          TEXT NOT NULL,
  "token"         TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "issuedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notBefore"     TIMESTAMP(3),
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "seats"         INTEGER NOT NULL DEFAULT 0,
  "notes"         TEXT,
  "issuedById"    TEXT NOT NULL,
  "issuedByEmail" TEXT NOT NULL,
  "revokedAt"     TIMESTAMP(3),
  "revokedById"   TEXT,
  "revokedReason" TEXT,

  CONSTRAINT "PlatformIssuedLicense_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformIssuedLicense_jti_key"
  ON "PlatformIssuedLicense"("jti");

-- "List licenses for tenant X, newest first" is the hot path on the
-- TenantDetail page. Compound index keeps it index-only.
CREATE INDEX "PlatformIssuedLicense_tenantSlug_issuedAt_idx"
  ON "PlatformIssuedLicense"("tenantSlug", "issuedAt" DESC);

CREATE INDEX "PlatformIssuedLicense_revokedAt_idx"
  ON "PlatformIssuedLicense"("revokedAt");

CREATE INDEX "PlatformIssuedLicense_expiresAt_idx"
  ON "PlatformIssuedLicense"("expiresAt");
