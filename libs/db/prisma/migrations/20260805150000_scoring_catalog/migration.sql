-- Admin-editable credit survey catalog.
--
-- The factor list and survey questions were constants in
-- @loan/credit-scoring. They become rows so a deployment can tune the
-- survey — but the SCALE stays fixed: factors carry a relative
-- `weight`, and the lib normalizes those onto a constant 150-point
-- total (largest-remainder apportionment, so the parts sum to the whole
-- exactly). Adding a factor redistributes points; it does not grow the
-- raw total. That pinning is what keeps a 720 meaning the same thing
-- after an edit, and what keeps decision rules that threshold on
-- `creditScoreAtApply` honest.
--
-- Existing scores are NOT recomputed. SurveyResponse.breakdown already
-- snapshots the per-factor explanation a score was computed with, so
-- history keeps its own arithmetic and a catalog edit can never
-- silently re-tier a borrower. They pick up the new catalog when their
-- survey is next run.
--
-- Seeding lives in seedScoringCatalog() (libs/db), called from the
-- tenant seed, so a fresh deployment starts byte-identical to the
-- shipped catalog rather than with an empty survey.
--
-- Hand-written, like every migration here — see the partial-index note
-- in 20260804050000_collection_assignment.

CREATE TYPE "SurveyQuestionKind" AS ENUM ('CHOICE', 'NUMBER', 'BOOLEAN');

CREATE TABLE "SurveyFactor" (
    "id" TEXT NOT NULL,
    -- Referenced by questions and by stored score breakdowns
    -- ("income", "on_time"). Renaming the label is safe; changing this
    -- would orphan historical breakdowns, so the API refuses.
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    -- Relative share, not points. Only ratios matter.
    "weight" DOUBLE PRECISION NOT NULL,
    -- Derived from loan history rather than a survey answer.
    "computed" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyFactor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyFactor_key_key" ON "SurveyFactor"("key");
CREATE INDEX "SurveyFactor_order_idx" ON "SurveyFactor"("order");

CREATE TABLE "SurveyQuestionDef" (
    "id" TEXT NOT NULL,
    -- SurveyResponse.answers is keyed by this, so it's as immutable as
    -- the factor key.
    "key" TEXT NOT NULL,
    "kind" "SurveyQuestionKind" NOT NULL,
    "label" TEXT NOT NULL,
    "help" TEXT,
    -- Free-text grouping heading, same convention as KYC declarations.
    "category" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- Kind-specific: CHOICE options[] with weights, NUMBER min/max/
    -- step/inverted, BOOLEAN weightWhenTrue. JSON because the three
    -- shapes share nothing; the API validates with a zod union.
    "config" JSONB NOT NULL,
    "factorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyQuestionDef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyQuestionDef_key_key" ON "SurveyQuestionDef"("key");
CREATE INDEX "SurveyQuestionDef_factorId_idx" ON "SurveyQuestionDef"("factorId");
CREATE INDEX "SurveyQuestionDef_order_idx" ON "SurveyQuestionDef"("order");

-- Cascade: a question without its factor scores nothing. The API
-- separately blocks deleting a factor that still has questions, so
-- reaching this cascade means a deliberate force-delete.
ALTER TABLE "SurveyQuestionDef"
    ADD CONSTRAINT "SurveyQuestionDef_factorId_fkey"
    FOREIGN KEY ("factorId") REFERENCES "SurveyFactor"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
