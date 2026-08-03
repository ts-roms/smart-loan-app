- Phase D — DORSI compliance.
--
-- Adds:
--   * DorsiCategory enum (Director / Officer / Stockholder / Related Interest)
--   * DorsiRecord table — one tag per customer.
--   * DorsiBoardApproval table — one approval per loan that needs board override.
--   * SystemConfig singleton holding the company total equity used as
--     the base for the 15% / 30% cap math.
--
-- Note: spelled "DORSI" per stakeholder preference. No
-- company-brand naming is hard-coded in the schema; the equity value is
-- configured at runtime through the SystemConfig table.

CREATE TYPE "DorsiCategory" AS ENUM (
  'DIRECTOR',
  'OFFICER',
  'STOCKHOLDER',
  'RELATED_INTEREST'
);

CREATE TABLE "DorsiRecord" (
  "id"                   TEXT NOT NULL,
  "customerId"           TEXT NOT NULL,
  "category"             "DorsiCategory" NOT NULL,
  "basis"                VARCHAR(500) NOT NULL,
  "active"               BOOLEAN NOT NULL DEFAULT true,
  "lastReviewedAt"       TIMESTAMP(3),
  "lastReviewedById"     TEXT,
  "taggedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "taggedById"           TEXT NOT NULL,
  "deactivatedAt"        TIMESTAMP(3),
  "deactivatedById"      TEXT,
  "deactivationReason"   VARCHAR(500),

  CONSTRAINT "DorsiRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DorsiRecord_customerId_key" ON "DorsiRecord"("customerId");
CREATE INDEX "DorsiRecord_category_active_idx" ON "DorsiRecord"("category", "active");
CREATE INDEX "DorsiRecord_active_idx" ON "DorsiRecord"("active");

ALTER TABLE "DorsiRecord" ADD CONSTRAINT "DorsiRecord_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DorsiRecord" ADD CONSTRAINT "DorsiRecord_taggedById_fkey"
  FOREIGN KEY ("taggedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DorsiRecord" ADD CONSTRAINT "DorsiRecord_lastReviewedById_fkey"
  FOREIGN KEY ("lastReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DorsiRecord" ADD CONSTRAINT "DorsiRecord_deactivatedById_fkey"
  FOREIGN KEY ("deactivatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DorsiBoardApproval" (
  "id"                       TEXT NOT NULL,
  "loanId"                   TEXT NOT NULL,
  "aggregateUtilizationPct"  DOUBLE PRECISION NOT NULL,
  "individualUtilizationPct" DOUBLE PRECISION NOT NULL,
  "meetingDate"              TIMESTAMP(3) NOT NULL,
  "minutesRef"               VARCHAR(200),
  "note"                     VARCHAR(500),
  "approvedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById"             TEXT NOT NULL,

  CONSTRAINT "DorsiBoardApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DorsiBoardApproval_loanId_key" ON "DorsiBoardApproval"("loanId");

ALTER TABLE "DorsiBoardApproval" ADD CONSTRAINT "DorsiBoardApproval_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DorsiBoardApproval" ADD CONSTRAINT "DorsiBoardApproval_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SystemConfig" (
  "id"                  TEXT NOT NULL DEFAULT 'singleton',
  "companyTotalEquity"  DECIMAL(20, 2) NOT NULL DEFAULT 0,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "updatedById"         TEXT,

  CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the singleton row so the dashboard has a base to multiply against.
INSERT INTO "SystemConfig" ("id", "companyTotalEquity", "updatedAt")
VALUES ('singleton', 0, CURRENT_TIMESTAMP);
