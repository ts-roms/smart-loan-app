-- Licensing: persisted record of every activated license token.
--
-- The current license is the most recent row with revokedAt IS NULL
-- AND expiresAt > now() whose signature still verifies. History stays
-- in the DB so admins can see when each upgrade/renewal happened.
CREATE TABLE "License" (
  "id"            TEXT NOT NULL,
  "token"         TEXT NOT NULL,
  "jti"           TEXT NOT NULL,
  "tenantName"    TEXT NOT NULL,
  "tier"          TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "issuedAt"      TIMESTAMP(3) NOT NULL,
  "notBefore"     TIMESTAMP(3),
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "seats"         INTEGER NOT NULL DEFAULT 0,
  "notes"         TEXT,
  "activatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedById" TEXT,
  "revokedAt"     TIMESTAMP(3),
  "revokedById"   TEXT,

  CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- The `jti` is the platform-assigned UUID inside the payload. Marking
-- it unique means re-pasting the same token on the same instance is a
-- no-op (Prisma's upsert will hit this constraint and update the
-- existing row instead of creating a duplicate).
CREATE UNIQUE INDEX "License_jti_key" ON "License"("jti");

-- The "current license" lookup wants rows where revokedAt IS NULL and
-- expiresAt > now(). Composite index lets that scan stay fast even
-- after a few years of license history.
CREATE INDEX "License_revokedAt_expiresAt_idx"
  ON "License"("revokedAt", "expiresAt");

ALTER TABLE "License"
  ADD CONSTRAINT "License_activatedById_fkey"
  FOREIGN KEY ("activatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "License"
  ADD CONSTRAINT "License_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
