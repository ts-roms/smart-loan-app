-- Scoring catalog versioning.
--
-- The counterpart to 20260811180000, shaped differently on purpose.
-- Decision rules are versioned one row at a time because they are
-- independent. The scorecard is not: factor points are derived from
-- relative weights against a fixed 150-point total, so raising one
-- factor's weight lowers every other factor's points. A change to one
-- factor IS a change to the whole catalog, so the whole catalog is what
-- gets versioned.
--
-- Additive. Nothing is dropped, no existing row changes meaning, and
-- scores computed before this keep a null `catalogVersion` — honest,
-- because the catalog of the day was genuinely never recorded.
--
-- The baseline snapshot is NOT written here. It is minted at boot by
-- ScoringCatalogRepository.ensureBaseline(), for one reason: the
-- snapshot has to be the shape @loan/credit-scoring consumes, including
-- the DEFAULT_CATALOG fallback for a tenant whose tables are still
-- empty. Reproducing that mapping in SQL would be a second copy of it,
-- and the second copy is the one that goes stale.

CREATE TYPE "ScoringCatalogChangeType" AS ENUM (
    'BASELINE',
    'FACTOR_ADDED',
    'FACTOR_CHANGED',
    'FACTOR_REMOVED',
    'QUESTION_ADDED',
    'QUESTION_CHANGED',
    'QUESTION_REMOVED',
    'REORDERED'
);

CREATE TABLE "ScoringCatalogVersion" (
    "id"            TEXT NOT NULL,
    "version"       INTEGER NOT NULL,
    "snapshot"      JSONB NOT NULL,
    "factorCount"   INTEGER NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"   TIMESTAMP(3),
    "changeType"    "ScoringCatalogChangeType" NOT NULL,
    "changeSummary" TEXT,
    "changeNote"    TEXT,
    "changedById"   TEXT,

    CONSTRAINT "ScoringCatalogVersion_pkey" PRIMARY KEY ("id")
);

-- Dense, 1-based, and — the part that matters — what serialises minting.
-- Two admins saving the builder at the same moment both compute the same
-- next version; this makes the second one's transaction roll back rather
-- than leaving two rows claiming to be current. Same shape as
-- DecisionRuleVersion_ruleId_version_key.
CREATE UNIQUE INDEX "ScoringCatalogVersion_version_key"
    ON "ScoringCatalogVersion" ("version");

CREATE INDEX "ScoringCatalogVersion_effectiveFrom_idx"
    ON "ScoringCatalogVersion" ("effectiveFrom" DESC);

-- ── Scores record which scorecard produced them ─────────────────────────

ALTER TABLE "CreditScore"    ADD COLUMN "catalogVersion" INTEGER;
ALTER TABLE "SurveyResponse" ADD COLUMN "catalogVersion" INTEGER;
