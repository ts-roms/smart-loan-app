-- Pre-assessment: run the decisioning rules before an application exists,
-- and keep the answer.
--
-- POST /loans/dry-run already previews the rules for an in-flight application
-- in the officer's new-loan wizard, but it needs a Customer row and stores
-- nothing. This table serves the two cases that need a record: a borrower
-- checking their own eligibility from the portal, and staff sizing up a
-- walk-in prospect who has no Customer row at all.
--
-- Hand-written, like every migration here. `prisma migrate dev` cannot be
-- used in this repo: several indexes are partial (e.g.
-- AuditEvent_impersonatedById_idx has WHERE ... IS NOT NULL), which
-- @@index() cannot express, so the differ always wants to recreate them and
-- collides on the existing name.

CREATE TYPE "PreAssessmentSource" AS ENUM ('PORTAL', 'OFFICER');

-- The rule engine's RuleAction flattened to what the UI shows. MANUAL_REVIEW
-- and "no rule matched" both land on REVIEW.
CREATE TYPE "PreAssessmentVerdict" AS ENUM ('APPROVE', 'REVIEW', 'REJECT');

CREATE TABLE "PreAssessment" (
    "id" TEXT NOT NULL,
    -- "PA-2026-000123". Quoted to the applicant, so it has to be stable and
    -- readable over the phone. Column is "number" to match every other
    -- human-numbered table here (Customer, LoanApplication, KycSubmission).
    "number" TEXT NOT NULL,
    "source" "PreAssessmentSource" NOT NULL,

    -- Subject: exactly one side is populated. PORTAL rows carry customerId
    -- and no prospect fields; OFFICER walk-in rows carry the reverse. Not a
    -- CHECK constraint — an officer assessing an *existing* customer
    -- legitimately fills in both, and the API decides which side wins.
    "customerId" TEXT,
    "prospectName" TEXT,
    "prospectPhone" TEXT,
    "prospectEmail" TEXT,

    -- Inputs, mirroring LoanApplication's precision so a converted
    -- assessment round-trips without rescaling.
    "productCode" TEXT NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "annualInterestRate" DECIMAL(6,4) NOT NULL,
    "monthlyIncome" DECIMAL(14,2) NOT NULL,
    "applicantAge" INTEGER NOT NULL,

    -- Outcome.
    "verdict" "PreAssessmentVerdict" NOT NULL,
    "reason" TEXT NOT NULL,
    -- Deliberately NOT a foreign key to DecisionRule: rules get edited and
    -- deleted, and a year-old verdict still has to be explainable, so the
    -- name is snapshotted next to the id.
    "matchedRuleId" TEXT,
    "matchedRuleName" TEXT,
    -- The DecisioningContext exactly as evaluated. Rules change; this is
    -- what they saw at the time.
    "context" JSONB NOT NULL,
    -- AML / KYC gates. NULL on prospect rows — no customer, no gates.
    "gates" JSONB,
    "anomalies" JSONB,

    -- Conversion into a real application.
    "loanId" TEXT,
    "convertedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Not a foreign key, same reasoning as Customer."erasedById": staff
    -- leave, and these rows stay on file for years afterwards.
    "createdById" TEXT,

    CONSTRAINT "PreAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreAssessment_number_key"
    ON "PreAssessment"("number");

-- One assessment converts into at most one loan.
CREATE UNIQUE INDEX "PreAssessment_loanId_key"
    ON "PreAssessment"("loanId");

-- The borrower's own history on the portal, and the officer's view of a
-- customer's prior checks.
CREATE INDEX "PreAssessment_customerId_createdAt_idx"
    ON "PreAssessment"("customerId", "createdAt" DESC);

-- The staff list view: everything, newest first.
CREATE INDEX "PreAssessment_createdAt_idx"
    ON "PreAssessment"("createdAt" DESC);

CREATE INDEX "PreAssessment_verdict_idx"
    ON "PreAssessment"("verdict");

-- SET NULL on both sides. An erased customer or a deleted loan must not take
-- the assessment with it: what we told someone, and when, is the record.
ALTER TABLE "PreAssessment"
    ADD CONSTRAINT "PreAssessment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PreAssessment"
    ADD CONSTRAINT "PreAssessment_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
