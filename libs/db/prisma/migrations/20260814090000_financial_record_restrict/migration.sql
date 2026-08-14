-- Money outlives the record it hangs off.
--
-- 20260811160000_coop_money_restrict closed this for Contribution and
-- SavingsTransaction, the two rows the Phase 0 audit named. It named two
-- because those were the two someone had noticed, not because those were
-- the two that existed. Walking every `onDelete: Cascade` in the schema
-- and asking "what does this destroy" turns up eight more that terminate
-- in money, and two that quietly unattribute it.
--
-- The reasoning is the same one that migration gave, and the same one
-- §55 gives for authorization: the guard has to live where the data
-- does. The services already refuse to delete these things — but a
-- service check is a promise, not a constraint. A maintenance script, a
-- psql session, a cascade arriving from a direction nobody modelled, or
-- an endpoint written next year all reach the table without passing the
-- promise. §12 says a posted financial transaction is reversed, never
-- deleted; §71 says regulated financial records are not deleted because
-- somebody asked for their PII back. RESTRICT is what those sentences
-- look like when the database enforces them.
--
-- ── What changes, and what it was destroying ────────────────────────────
--
-- The dangerous shape is a delete of something that does NOT look like
-- money silently taking money with it. Deleting a LoanApplication reads
-- like discarding a form; it took every payment ever posted against the
-- loan, the schedule recording what was owed and collected, the gateway
-- charges, the fee waivers, and the auction/lease settlements.
--
--   LoanSchedule.loanId        the receivable itself — principalDue /
--                              interestDue, and principalPaid /
--                              interestPaid recording what was collected
--                              against each instalment.
--   LoanPayment.loanId         posted payments. §12, exactly.
--   PaymentIntent.loanId       gateway charges: amount, provider,
--                              externalId. The record that a borrower's
--                              card or wallet was actually debited.
--   PenaltyWaiver.loanId       money written off, carrying an FK to the
--                              GL reversal that booked it.
--   RepossessionCase.loanId    auctionProceeds, outstandingAtRecovery,
--                              deficiency (booked as bad debt), plus an
--                              FK to the auction settlement entry.
--   LeaseAgreement.loanId      residualValue and buyoutPaidAmount, plus
--                              an FK to the buyout entry.
--   JournalLine.entryId        the ledger rows. Debits and credits are
--                              the books; nothing below them is derived.
--   AgentPayoutItem.payoutId   commission cash that left the building.
--
-- Two more are not cascades but do comparable damage. FundTransaction
-- and FundWithdrawal point at Customer with ON DELETE SET NULL, so
-- deleting a member did not destroy their fund movements — it silently
-- detached them, leaving coop cash on the books attributed to nobody.
-- That is the same hole 20260811160000 was written to close, in the same
-- domain, one column over. The row surviving unattributed is better than
-- the row vanishing and still not good enough.
--
--   FundTransaction.customerId   SET NULL -> RESTRICT
--   FundWithdrawal.customerId    SET NULL -> RESTRICT
--
-- Both columns stay NULLABLE: a fund movement that was never
-- member-attributable still carries NULL, and RESTRICT has nothing to
-- say about that. Only rows that DO name a member now pin that member.
--
-- ── What deliberately keeps its cascade ─────────────────────────────────
--
-- Thirty relations keep ON DELETE CASCADE, because changing all of them
-- would be as unconsidered as changing none. They fall in three groups:
--
--   Assessment and identity hanging off Customer — KycSubmission,
--   CreditScore, SurveyResponse, AmlScreening, DorsiRecord. None is
--   money. And after this migration a Customer who has any money at all
--   (loan, contribution, savings, fund movement) cannot be deleted in
--   the first place, so the only customer these can still follow into
--   the ground is one who never transacted.
--
--   Activity and governance hanging off LoanApplication — LoanApproval,
--   CollectionNote, PromiseToPay, CollectionAssignment, CoMaker,
--   LoanMessage, DemandLetter, AnnualDocument, DorsiBoardApproval. These
--   record what people did about a loan, not what money did. PromiseToPay
--   carries an `amount` and is the closest call: it is a commitment a
--   collector recorded, never posted to the ledger, and it dies with the
--   loan it promises against. CoMaker keeps its cascade because the
--   person is protected separately — CoMaker.customerId is already
--   RESTRICT.
--
--   Configuration, join rows and sessions — SurveyQuestionDef,
--   LoanApprovalStep, LoanDraft, JobRun, CoMakerDocument,
--   DecisionRuleVersion, RoleInheritance, RolePermission,
--   UserRoleAssignment, PasswordResetToken, RefreshToken, and
--   BankStatementLine. Each is meaningless without its parent. A
--   RolePermission with no role is not a fact about anything;
--   a bank statement line is a copy of the bank's own record of an
--   import, re-importable from the same CSV, and posts nothing to the GL.
--
-- ── Compliance erasure is unaffected ────────────────────────────────────
--
-- apps/api/src/features/compliance/compliance.service.ts eraseCustomer
-- never deletes: it overwrites the PII columns in place and stamps
-- erasedAt, precisely so financial relations keep resolving to a valid
-- Customer.id. It has no delete to break. RetentionService.runPurge
-- deletes only AuditEvent, Notification and JobRun, none of which is
-- touched here.
--
-- ── Safe to apply ───────────────────────────────────────────────────────
--
-- Altering a referential action rewrites no rows and validates nothing
-- retroactively — it only changes what a FUTURE delete is allowed to do.
-- No data is read, moved or removed by this migration. The DROP
-- CONSTRAINT below is not a drop of anything durable: Postgres has no
-- "ALTER CONSTRAINT ... ON DELETE", so drop-and-recreate in one
-- transaction is the only way to change the action, and it is the same
-- shape 20260811160000_coop_money_restrict used.
--
-- Table names are deliberately unqualified. `prisma migrate deploy` runs
-- with DATABASE_URL carrying `?schema=tenant_<slug>`, so an unqualified
-- name resolves to whichever schema is being migrated — that is what
-- lets the fan-out in libs/db/scripts/migrate-tenants.mjs apply this to
-- every tenant. Do not schema-qualify them.
--
-- ROLLBACK: re-run each statement with the original action in place of
-- RESTRICT — CASCADE for the eight, SET NULL for the two fund tables.
-- Nothing else has to be undone, because nothing else was done.

-- ── Cascades that terminated in money ───────────────────────────────────

ALTER TABLE "LoanSchedule"
  DROP CONSTRAINT "LoanSchedule_loanId_fkey",
  ADD CONSTRAINT "LoanSchedule_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LoanPayment"
  DROP CONSTRAINT "LoanPayment_loanId_fkey",
  ADD CONSTRAINT "LoanPayment_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentIntent"
  DROP CONSTRAINT "PaymentIntent_loanId_fkey",
  ADD CONSTRAINT "PaymentIntent_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PenaltyWaiver"
  DROP CONSTRAINT "PenaltyWaiver_loanId_fkey",
  ADD CONSTRAINT "PenaltyWaiver_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RepossessionCase"
  DROP CONSTRAINT "RepossessionCase_loanId_fkey",
  ADD CONSTRAINT "RepossessionCase_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaseAgreement"
  DROP CONSTRAINT "LeaseAgreement_loanId_fkey",
  ADD CONSTRAINT "LeaseAgreement_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalLine"
  DROP CONSTRAINT "JournalLine_entryId_fkey",
  ADD CONSTRAINT "JournalLine_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AgentPayoutItem"
  DROP CONSTRAINT "AgentPayoutItem_payoutId_fkey",
  ADD CONSTRAINT "AgentPayoutItem_payoutId_fkey"
    FOREIGN KEY ("payoutId") REFERENCES "AgentPayout"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SET NULLs that silently unattributed money ──────────────────────────

ALTER TABLE "FundTransaction"
  DROP CONSTRAINT "FundTransaction_customerId_fkey",
  ADD CONSTRAINT "FundTransaction_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FundWithdrawal"
  DROP CONSTRAINT "FundWithdrawal_customerId_fkey",
  ADD CONSTRAINT "FundWithdrawal_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
