-- Marketing lead capture from apps/marketing.
--
-- Anonymous endpoint (POST /public/leads) writes here. Lives in
-- `public` schema because leads exist before any Tenant does — they
-- ARE the sales pipeline that becomes Tenants.

CREATE TYPE "LeadDeploymentInterest" AS ENUM ('ONPREM', 'HOSTED', 'BOTH');
CREATE TYPE "LeadStatus" AS ENUM (
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'REJECTED'
);

CREATE TABLE "Lead" (
  "id"                 TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "email"              TEXT NOT NULL,
  "cooperative"        TEXT NOT NULL,
  "memberCount"        INTEGER,
  "deploymentInterest" "LeadDeploymentInterest" NOT NULL DEFAULT 'ONPREM',
  "message"            TEXT,
  "source"             TEXT,
  "status"             "LeadStatus" NOT NULL DEFAULT 'NEW',
  "assignedToId"       TEXT,
  "notes"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- "Show me NEW leads, newest first" is the hot path on the platform
-- console's leads board. Compound index keeps it index-only.
CREATE INDEX "Lead_status_createdAt_idx"
  ON "Lead"("status", "createdAt" DESC);

CREATE INDEX "Lead_email_idx" ON "Lead"("email");
