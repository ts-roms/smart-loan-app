-- §26: payment allocation becomes configurable.
--
-- Adds the order as an enum, a per-product default for NEW loans, and a
-- per-loan snapshot that is the only thing `recordPayment` actually reads.
--
-- THE POINT OF THE SNAPSHOT. Adding fee and penalty tiers ahead of interest
-- changes how much of every future payment reduces principal. For a loan
-- already on the books that is a change to the borrower's economics
-- mid-contract. If allocation were read through the product, an admin
-- editing LoanProduct.paymentAllocationOrder would reprice every live loan
-- under that product in one UPDATE, silently. So the loan carries its own
-- order, copied from the product at creation and never re-read from it —
-- the same snapshot-not-reference reasoning as LoanProduct.kycQuestions vs
-- LoanApplication.kycDeclarations.
--
-- DATA. Both columns are NOT NULL with DEFAULT 'INTEREST_PRINCIPAL', which
-- is exactly what every existing row was already doing: interest then
-- principal, per instalment, no fee or penalty tier. Postgres 11+ fills a
-- NOT NULL DEFAULT from the catalogue without rewriting the heap, so this
-- is a metadata-only change on both tables and no row is read or written.
-- Nothing is backfilled because the default IS the backfill, and it is the
-- honest value: these loans have been paying under this order all along.
--
-- No existing loan changes behaviour. A product has to be deliberately
-- moved onto a different order, and even then only loans created AFTER
-- that edit pick it up.
--
-- Table and type names are deliberately unqualified. `prisma migrate deploy`
-- runs with DATABASE_URL carrying `?schema=tenant_<slug>`
-- (libs/db/src/lib/multi-tenant-migrate.ts), so an unqualified name resolves
-- to whichever schema is being migrated — that is what makes the tenant
-- fan-out in libs/db/scripts/migrate-tenants.mjs apply this to every tenant
-- and not just to `public`. Do not schema-qualify them. The enum TYPE is
-- created per schema for the same reason; two tenants each get their own,
-- which is correct and is how every other enum in this schema already works.
--
-- LOCKING: ADD COLUMN with a non-volatile DEFAULT takes an ACCESS EXCLUSIVE
-- lock for the catalogue update only — no table scan, no rewrite — so it is
-- sub-millisecond regardless of how many loans a tenant has. CREATE TYPE
-- takes no lock on anything that exists yet.
--
-- ROLLBACK. Dropping the two columns and the type restores the previous
-- state exactly, and loses nothing that was not derivable: before this
-- migration every loan was on INTEREST_PRINCIPAL by construction. The
-- application must be rolled back FIRST — code that reads
-- `paymentAllocationOrder` against a database without it fails on every
-- payment. If any loan has been moved off INTEREST_PRINCIPAL by then, the
-- rollback silently returns it to the legacy order, so check before
-- running it:
--
--   SELECT id, number, "paymentAllocationOrder" FROM "LoanApplication"
--    WHERE "paymentAllocationOrder" <> 'INTEREST_PRINCIPAL';
--
--   ALTER TABLE "LoanApplication" DROP COLUMN "paymentAllocationOrder";
--   ALTER TABLE "LoanProduct" DROP COLUMN "paymentAllocationOrder";
--   DROP TYPE "PaymentAllocationOrder";

-- CreateEnum
CREATE TYPE "PaymentAllocationOrder" AS ENUM (
  'INTEREST_PRINCIPAL',
  'FEES_PENALTIES_INTEREST_PRINCIPAL',
  'INTEREST_PRINCIPAL_FEES_PENALTIES'
);

-- AlterTable: the default handed to loans written under this product from
-- now on. Not consulted for any loan that already exists.
ALTER TABLE "LoanProduct"
  ADD COLUMN "paymentAllocationOrder" "PaymentAllocationOrder" NOT NULL
  DEFAULT 'INTEREST_PRINCIPAL';

-- AlterTable: the order this loan actually pays under. Existing rows take
-- the default, which is what they were already doing.
ALTER TABLE "LoanApplication"
  ADD COLUMN "paymentAllocationOrder" "PaymentAllocationOrder" NOT NULL
  DEFAULT 'INTEREST_PRINCIPAL';
