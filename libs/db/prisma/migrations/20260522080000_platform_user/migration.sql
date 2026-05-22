-- Phase 3 foundation — platform-side user table + audit.
--
-- Strictly separate from the tenant-side User table. Platform users
-- are the vendor's team (PLATFORM_ADMIN can do anything, PLATFORM_SALES
-- can view + issue licenses but not destructively touch tenants).
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_ADMIN', 'PLATFORM_SALES');

CREATE TABLE "PlatformUser" (
  "id"           TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "role"         "PlatformRole" NOT NULL DEFAULT 'PLATFORM_SALES',
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "lastLoginAt"  TIMESTAMP(3),

  CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");

CREATE TABLE "PlatformAuditLog" (
  "id"         TEXT NOT NULL,
  "action"     TEXT NOT NULL,
  "actorId"    TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "tenantSlug" TEXT,
  "payload"    JSONB NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");
CREATE INDEX "PlatformAuditLog_actorId_idx" ON "PlatformAuditLog"("actorId");
CREATE INDEX "PlatformAuditLog_tenantSlug_idx" ON "PlatformAuditLog"("tenantSlug");
