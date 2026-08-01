-- Per-installment payment progress + a home for overpayments.
--
-- Background. LoanSchedule tracked only `principalPaid`, and that column was
-- written exclusively by the payment that settled an installment outright.
-- Payment allocation therefore ran against each open installment's FULL
-- interestDue/principalDue every time, so a borrower paying one installment
-- in several slices had the same interest recognized once per slice and
-- nothing credited to principal. Each journal entry balanced on its own, so
-- the balance check never caught it.
--
-- Two changes here:
--
--   1. `interestPaid` — the interest counterpart of `principalPaid`.
--      Together they let allocation work against REMAINING due per
--      installment and let an installment be marked paid once the
--      cumulative total (not one payment) covers it.
--
--   2. Account 2100 "Customer Advance Payments" — a liability for money
--      received beyond everything a loan still owes. Previously the excess
--      was folded into the principal credit, pushing Loans Receivable
--      negative for that borrower.
--
-- Backfill note. Rows already flagged `paidInFullAt` get `interestPaid`
-- set to `interestDue`, preserving the invariant "settled row => nothing
-- remaining". That covers rows settled by a real payment as well as rows
-- force-settled by write-off / restructure / repossession, which already
-- set `principalPaid = principalDue` on the same basis: the installment is
-- closed out, so it has no remaining due. It does NOT assert that cash was
-- collected — recognized income lives in the journal entries, never here.
--
-- Open rows keep interestPaid = 0. Loans that took partial payments under
-- the old code have understated progress AND misstated journal entries;
-- neither is repairable in SQL. Run the auditor for that:
--   pnpm --filter @loan/db repair-payments            (dry run, reports only)
--   pnpm --filter @loan/db repair-payments --apply

ALTER TABLE "LoanSchedule"
  ADD COLUMN "interestPaid" DECIMAL(14,2) NOT NULL DEFAULT 0;

UPDATE "LoanSchedule"
  SET "interestPaid" = "interestDue"
  WHERE "paidInFullAt" IS NOT NULL;

-- Seed the new GL account directly so existing databases can post payments
-- immediately after deploy. `AccountingRepository.seedDefaultChart` would
-- also create it, but auto-posting resolves account codes at post time and
-- throws on an unknown code — waiting for the next seed run would break
-- every overpayment in the interim.
-- `Account.id` is a TEXT column with no DB-side default (Prisma generates
-- uuids client-side), so the literal below stands in for one.
INSERT INTO "Account" ("id", "code", "name", "type", "normalBalance", "description", "active", "system", "createdAt", "updatedAt")
VALUES (
  '2100a0de-0000-4000-8000-000000002100',
  '2100',
  'Customer Advance Payments',
  'LIABILITY',
  'CREDIT',
  'Payments received in excess of everything a loan still owes. Refundable to the borrower or applied to a future obligation.',
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;
