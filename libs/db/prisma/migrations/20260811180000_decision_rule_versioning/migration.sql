-- Decision-rule versioning (GAP-18).
--
-- Before this, DecisionRule was one mutable row per rule. Retuning a rule
-- overwrote it, so the only answer available to "on what basis was this
-- loan approved in March?" was what the rule says today — and retuning is
-- the entire reason the criteria live in a table rather than in code.
--
-- Additive and backfilling. Nothing is dropped, no existing row changes
-- meaning, and every rule already on file gets a version 1 describing it
-- as it currently stands. That version's effectiveFrom is the rule's own
-- createdAt, not now(): claiming a rule took effect at migration time
-- would be a worse record than none, because it would look precise.
--
-- Loans decided before this migration keep null decision-rule columns.
-- That is honest — the information was never captured — and is why the
-- columns are nullable rather than defaulted.

-- ── History table ───────────────────────────────────────────────────────

CREATE TYPE "DecisionRuleChangeType" AS ENUM ('CREATE', 'UPDATE', 'RETIRE');

CREATE TABLE "DecisionRuleVersion" (
    "id"            TEXT NOT NULL,
    "ruleId"        TEXT NOT NULL,
    "version"       INTEGER NOT NULL,
    "ruleName"      TEXT NOT NULL,
    "description"   TEXT,
    "priority"      INTEGER NOT NULL,
    "conditions"    JSONB NOT NULL,
    "action"        "RuleAction" NOT NULL,
    "reason"        TEXT,
    "active"        BOOLEAN NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"   TIMESTAMP(3),
    "changeType"    "DecisionRuleChangeType" NOT NULL,
    "changeNote"    TEXT,
    "changedById"   TEXT,

    CONSTRAINT "DecisionRuleVersion_pkey" PRIMARY KEY ("id")
);

-- Resolves LoanApplication.decisionRuleVersion, and — more importantly —
-- serialises minting. Two admins saving the same rule concurrently both
-- compute the same next version; this index makes the second one lose
-- inside its own transaction rather than producing two "current" rules.
CREATE UNIQUE INDEX "DecisionRuleVersion_ruleId_version_key"
    ON "DecisionRuleVersion" ("ruleId", "version");

CREATE INDEX "DecisionRuleVersion_ruleId_effectiveFrom_idx"
    ON "DecisionRuleVersion" ("ruleId", "effectiveFrom" DESC);

CREATE INDEX "DecisionRuleVersion_effectiveFrom_idx"
    ON "DecisionRuleVersion" ("effectiveFrom");

-- Cascade is right here and only here: the history belongs to the rule,
-- and a rule row is only ever removed by an operator deliberately purging
-- it. The decisions that CITE a version do not go through this FK — they
-- snapshot ruleId/name/version as plain columns — so purging a rule
-- cannot orphan a loan's explanation into a dangling reference.
ALTER TABLE "DecisionRuleVersion"
    ADD CONSTRAINT "DecisionRuleVersion_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "DecisionRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Rule gains its version pointer ──────────────────────────────────────

ALTER TABLE "DecisionRule"
    ADD COLUMN "version"       INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "retiredAt"     TIMESTAMP(3);

UPDATE "DecisionRule" SET "effectiveFrom" = "createdAt";

-- ── Backfill version 1 for every existing rule ──────────────────────────
--
-- CREATE, not UPDATE: as far as the record is concerned this is the first
-- text of the rule anyone can attest to. changedById is null because it is
-- genuinely unknown — the old table never recorded who wrote a rule.
INSERT INTO "DecisionRuleVersion" (
    "id", "ruleId", "version", "ruleName", "description", "priority",
    "conditions", "action", "reason", "active",
    "effectiveFrom", "effectiveTo", "changeType", "changeNote", "changedById"
)
SELECT
    gen_random_uuid()::text,
    r."id", 1, r."name", r."description", r."priority",
    r."conditions", r."action", r."reason", r."active",
    r."createdAt", NULL, 'CREATE',
    'Backfilled at migration: the rule as it stood when versioning was introduced.',
    NULL
FROM "DecisionRule" r;

-- ── Decisions record which version decided them ─────────────────────────

ALTER TABLE "LoanApplication"
    ADD COLUMN "decisionRuleId"      TEXT,
    ADD COLUMN "decisionRuleName"    TEXT,
    ADD COLUMN "decisionRuleVersion" INTEGER,
    ADD COLUMN "decisionContext"     JSONB;

ALTER TABLE "PreAssessment"
    ADD COLUMN "matchedRuleVersion" INTEGER;
