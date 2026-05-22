-- Phase 2 foundation — the Tenant catalog table.
--
-- Lives in the shared `public` schema. Per-tenant domain data will move
-- into `tenant_<slug>` schemas in a follow-up commit; this migration is
-- a no-op for the existing single-tenant deploy (no rows, no queries
-- against it yet), but ships the table now so the platform console
-- (Phase 3) can target a stable shape.
CREATE TYPE "TenantStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TABLE "Tenant" (
  "id"              TEXT NOT NULL,
  "slug"            TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "status"          "TenantStatus" NOT NULL DEFAULT 'PROVISIONING',
  "licenseSnapshot" JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "lastSeenAt"      TIMESTAMP(3),

  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");
CREATE INDEX "Tenant_lastSeenAt_idx" ON "Tenant"("lastSeenAt");
