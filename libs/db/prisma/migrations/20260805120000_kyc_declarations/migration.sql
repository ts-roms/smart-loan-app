-- Per-product KYC declaration questionnaires.
--
-- Products already configure which DOCUMENTS their KYC pack requires
-- (requiredKycDocs); this adds configurable QUESTIONS — source of
-- funds, PEP status, purpose — that differ per product the same way
-- (housing asks about the property, salary asks about employment).
--
-- Two JSON columns rather than question/answer tables, following the
-- codebase's snapshot convention (DecisionRule.conditions,
-- PreAssessment.context): the product holds the live questionnaire,
-- and each application freezes the questions WITH its answers, so an
-- admin editing the questionnaire never rewrites what an applicant
-- already attested to, and approval can gate on exactly what was
-- asked at apply time.
--
-- Hand-written, like every migration here — see the partial-index note
-- in 20260804050000_collection_assignment.

-- The admin-built questionnaire: array of
--   { id, label, type: TEXT|YES_NO|NUMBER|SELECT, options?, required, hint? }
-- NULL (or an empty array) = no questionnaire; the product asks nothing
-- and gates nothing, which is every product until an admin builds one.
ALTER TABLE "LoanProduct" ADD COLUMN "kycQuestions" JSONB;

-- The application-side snapshot:
--   { items: [{ id, label, type, required, answer }], answeredAt, answeredById }
-- Unanswered questions are kept with answer NULL — what was ASKED is
-- part of the record, not only what was answered.
ALTER TABLE "LoanApplication" ADD COLUMN "kycDeclarations" JSONB;
