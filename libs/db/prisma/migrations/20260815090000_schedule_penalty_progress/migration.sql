-- §26 follow-through: a late fee becomes something a borrower can pay.
--
-- The allocator has had a PENALTIES tier since 20260814120000, and not one
-- peso has moved through it, because `recordPayment` had no per-instalment
-- penalty balance to hand it. This adds the two figures that were missing —
-- and only those two.
--
-- WHAT IS **NOT** ADDED, AND WHY THAT IS THE DESIGN
--
-- There is no `penaltyAccrued` column. What accrued against an instalment is
-- already recorded, exactly, in the ledger: `LATE_FEE_ACCRUAL` entries are
-- keyed `"<scheduleId>:<periodKey>"` in `JournalEntry.sourceRefId`, and the
-- sum of their Fee Income (4100) credits is the figure `accruedPenaltiesFor`
-- has reported to the loans route, demand letters and repossession since the
-- feature shipped. Copying it into a column would create a second version of
-- a number the ledger already holds, and every P0 this modernization has
-- closed came from a second version of a number.
--
-- The two columns below are the parts that are genuinely NOT derivable:
--
--   `penaltyPaid`   — nothing in the ledger says WHICH instalment a payment's
--                     penalty portion settled. The credit lands on Loans
--                     Receivable (1100) exactly as principal does, separated
--                     only by a memo string. A memo is not a subledger.
--   `penaltyWaived` — `PenaltyWaiver` carries a `loanId` and an amount and no
--                     instalment reference at all.
--
-- Keeping accrual out of the columns is also what makes the backfill honest;
-- see BACKFILL below.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────
--
-- `penaltyPaid` starts at 0 on every existing row and this forgives nothing.
-- It is not an assumption, it is provable from the code that has been
-- running: `recordPayment` never passed `penaltyDue`, so `openByTier`
-- resolved the tier to `max(0, 0 - 0)`, `allocation.penalties` came back
-- `undefined` on every payment ever recorded, and `loanPaymentEntry` omitted
-- the line. No peso of penalty has ever been collected by this system. Zero
-- is the true figure, not a convenient one.
--
-- What the accrued side would have made unsafe is the reason it is not a
-- column. Had `penaltyAccrued` been added and defaulted to 0, every peso of
-- late fee already sitting in the receivable would have vanished from the
-- per-instalment view the moment this ran — real debt, silently forgiven,
-- with the ledger still carrying it and the two no longer agreeing. Reading
-- accrual from the ledger means there is nothing to lose: the balance
-- carries over untouched because it never moved.
--
-- `penaltyWaived` is the opposite case and MUST be backfilled. Waivers exist
-- on the books today. Leaving the column at 0 would make every already-
-- forgiven peso collectable again the first time one of those loans took a
-- payment under an order that carries the penalty tier — re-charging debt a
-- manager signed off writing away, which is worse than the forgiveness
-- problem and points the same direction: at the borrower.
--
-- The attribution rule, here and in `waivePenalty`, is OLDEST INSTALMENT
-- FIRST, capped by what that instalment actually accrued. It matches the
-- allocator's own instalment-major walk and the arrears convention used
-- everywhere else in this system; a waiver is a concession on the oldest
-- arrears, and it settles whole instalments rather than leaving a borrower
-- with a fraction still owing on every overdue row. The alternatives were
-- considered and rejected: pro-rata leaves sub-centavo residues on every row
-- and has no servicing convention behind it, and an explicit instalment
-- reference asks the approving officer a question the waiver form has never
-- put to them and that no historical row can answer.
--
-- Because `penaltyPaid` is 0 everywhere at this instant, each instalment's
-- capacity to absorb waiver here is simply what it accrued, and the greedy
-- fill below is exact.
--
-- A waiver larger than everything the loan accrued cannot be produced by
-- `waivePenalty` (it validates), but if one exists from a repair script the
-- `LEAST`/`GREATEST` clamp leaves the excess unattributed rather than
-- writing a figure no instalment can support. That divergence is then
-- reported by the `penalty_subledger` check in `runReconciliation` instead
-- of being buried in a column — which is the whole point of adding the
-- check alongside the columns.
--
-- ── TENANCY ─────────────────────────────────────────────────────────────
--
-- Table names are deliberately unqualified. `prisma migrate deploy` runs with
-- DATABASE_URL carrying `?schema=tenant_<slug>` (libs/db/src/lib/
-- multi-tenant-migrate.ts), so an unqualified name resolves to whichever
-- schema is being migrated. That is what makes the tenant fan-out in
-- libs/db/scripts/migrate-tenants.mjs apply this to every tenant and not just
-- to `public`. Do not schema-qualify them.
--
-- ── LOCKING ─────────────────────────────────────────────────────────────
--
-- ADD COLUMN with a non-volatile DEFAULT is a catalogue update on Postgres
-- 11+ — ACCESS EXCLUSIVE for the metadata write, no heap rewrite, no scan —
-- so it is sub-millisecond whatever the tenant's size.
--
-- The backfill is the part that touches rows, and it touches only instalments
-- of loans that have a `PenaltyWaiver`. On any real book that is a small
-- minority of `LoanSchedule`; a tenant with no waivers at all writes nothing.
-- The accrual aggregate reads `JournalEntry` filtered to LATE_FEE_ACCRUAL via
-- `JournalEntry_source_refType_refId_prefix_idx` (20260813090000).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────
--
-- Drop the two columns. Nothing else in the schema references them and no
-- ledger row depends on them.
--
--   ALTER TABLE "LoanSchedule" DROP COLUMN "penaltyPaid";
--   ALTER TABLE "LoanSchedule" DROP COLUMN "penaltyWaived";
--
-- The application must be rolled back FIRST — code that writes `penaltyPaid`
-- against a database without it fails on every payment.
--
-- Rolling back is lossless for `penaltyWaived`: it is a pure function of
-- `PenaltyWaiver` and the accrual ledger, both untouched, so re-running this
-- migration reconstructs it. It is NOT lossless for `penaltyPaid` once any
-- penalty has actually been collected: dropping the column loses the record
-- of which instalment was settled, and the money stays collected in the GL,
-- so the receivable check would then report the difference. Before rolling
-- back after go-live, check whether any has been:
--
--   SELECT COUNT(*) FROM "LoanSchedule" WHERE "penaltyPaid" > 0;
--
-- If that is non-zero, capture the rows before dropping the column.

-- AlterTable. Both NOT NULL DEFAULT 0 — metadata-only, no rewrite.
ALTER TABLE "LoanSchedule"
  ADD COLUMN "penaltyPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "penaltyWaived" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Backfill `penaltyWaived` from existing waivers, oldest instalment first.
--
-- `accrual` — what each instalment accrued, from the ledger. The join back to
-- the schedule id is `split_part(sourceRefId, ':', 1)`, which is exactly the
-- `startsWith '<id>:'` filter the application uses read back the other way:
-- schedule ids are uuids and contain no colon, so the segment before the
-- first colon can only have been produced by that schedule.
--
-- `waived` — the loan's total forgiven, all waivers summed.
--
-- `sched` — every instalment of a loan that HAS a waiver, with a running sum
-- of what the instalments BEFORE it accrued. The frame stops at `1 PRECEDING`
-- so the row's own accrual is excluded; that running total is how much of the
-- waiver the older rows have already absorbed.
--
-- The fill is then per row and needs no iteration: this instalment takes
-- whatever is left of the waiver after the older ones, capped at its own
-- accrual and floored at zero.
WITH accrual AS (
  SELECT split_part(e."sourceRefId", ':', 1) AS schedule_id,
         SUM(l."credit")                     AS accrued
    FROM "JournalEntry" e
    JOIN "JournalLine"  l ON l."entryId"   = e."id"
    JOIN "Account"      a ON a."id"        = l."accountId"
   WHERE e."source"        = 'LATE_FEE_ACCRUAL'
     AND e."sourceRefType" = 'LoanScheduleLateFee'
     AND e."sourceRefId"  IS NOT NULL
     AND a."code"          = '4100'
   GROUP BY 1
),
waived AS (
  SELECT "loanId", SUM("waivedAmount") AS total
    FROM "PenaltyWaiver"
   GROUP BY "loanId"
),
sched AS (
  SELECT s."id",
         w."total"                        AS loan_waived,
         COALESCE(ac."accrued", 0)        AS accrued,
         COALESCE(
           SUM(COALESCE(ac."accrued", 0)) OVER (
             PARTITION BY s."loanId"
             ORDER BY     s."installmentNo"
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0)                          AS accrued_before
    FROM "LoanSchedule" s
    JOIN waived  w  ON w."loanId"      = s."loanId"
    LEFT JOIN accrual ac ON ac."schedule_id" = s."id"
),
alloc AS (
  SELECT "id",
         GREATEST(0, LEAST("accrued", "loan_waived" - "accrued_before")) AS here
    FROM sched
)
UPDATE "LoanSchedule" s
   SET "penaltyWaived" = a."here"
  FROM alloc a
 WHERE s."id" = a."id"
   AND a."here" > 0;
