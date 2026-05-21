-- ──────────────────────────────────────────────────────────────────────
-- Entity numbers — adds human-readable identifiers ("CUST-2026-000123"
-- etc.) to entities that previously only had UUIDs. URLs and operator
-- UI now show these instead, with UUIDs kept internal for FK joins.
--
-- Each ALTER below:
--   1. adds the column as nullable so the table accepts the change
--      against existing rows,
--   2. backfills with row_number()-based sequences scoped by created year
--      (or just a flat counter for entities without a creation timestamp),
--   3. makes the column NOT NULL + adds the UNIQUE constraint.
--
-- After this lands, application code is responsible for generating new
-- numbers via the per-repo `nextNumber()` helpers (the same pattern the
-- existing LoanApplication.number + JournalEntry.number already use).
-- ──────────────────────────────────────────────────────────────────────

-- ── Customer ─────────────────────────────────────────────────────────
ALTER TABLE "Customer" ADD COLUMN "number" TEXT;

WITH ranked AS (
  SELECT
    id,
    EXTRACT(YEAR FROM "createdAt")::int AS yr,
    row_number() OVER (
      PARTITION BY EXTRACT(YEAR FROM "createdAt")
      ORDER BY "createdAt", id
    ) AS seq
  FROM "Customer"
)
UPDATE "Customer" c
SET "number" = 'CUST-' || r.yr || '-' || LPAD(r.seq::text, 6, '0')
FROM ranked r
WHERE c.id = r.id;

ALTER TABLE "Customer" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Customer_number_key" ON "Customer"("number");


-- ── KycSubmission ────────────────────────────────────────────────────
ALTER TABLE "KycSubmission" ADD COLUMN "number" TEXT;

WITH ranked AS (
  SELECT
    id,
    EXTRACT(YEAR FROM "submittedAt")::int AS yr,
    row_number() OVER (
      PARTITION BY EXTRACT(YEAR FROM "submittedAt")
      ORDER BY "submittedAt", id
    ) AS seq
  FROM "KycSubmission"
)
UPDATE "KycSubmission" k
SET "number" = 'KYC-' || r.yr || '-' || LPAD(r.seq::text, 6, '0')
FROM ranked r
WHERE k.id = r.id;

ALTER TABLE "KycSubmission" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "KycSubmission_number_key" ON "KycSubmission"("number");


-- ── PaymentIntent ────────────────────────────────────────────────────
ALTER TABLE "PaymentIntent" ADD COLUMN "number" TEXT;

WITH ranked AS (
  SELECT
    id,
    EXTRACT(YEAR FROM "createdAt")::int AS yr,
    row_number() OVER (
      PARTITION BY EXTRACT(YEAR FROM "createdAt")
      ORDER BY "createdAt", id
    ) AS seq
  FROM "PaymentIntent"
)
UPDATE "PaymentIntent" p
SET "number" = 'PI-' || r.yr || '-' || LPAD(r.seq::text, 6, '0')
FROM ranked r
WHERE p.id = r.id;

ALTER TABLE "PaymentIntent" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "PaymentIntent_number_key" ON "PaymentIntent"("number");


-- ── Vehicle ──────────────────────────────────────────────────────────
-- Vehicles don't have a creation year that's meaningful for the prefix
-- (a 2018 car added in 2026 should still be VEH-something based on add
-- order), so this is a flat counter.
ALTER TABLE "Vehicle" ADD COLUMN "number" TEXT;

WITH ranked AS (
  SELECT id,
         row_number() OVER (ORDER BY "createdAt", id) AS seq
  FROM "Vehicle"
)
UPDATE "Vehicle" v
SET "number" = 'VEH-' || LPAD(r.seq::text, 6, '0')
FROM ranked r
WHERE v.id = r.id;

ALTER TABLE "Vehicle" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Vehicle_number_key" ON "Vehicle"("number");


-- ── Property ─────────────────────────────────────────────────────────
ALTER TABLE "Property" ADD COLUMN "number" TEXT;

WITH ranked AS (
  SELECT id,
         row_number() OVER (ORDER BY "createdAt", id) AS seq
  FROM "Property"
)
UPDATE "Property" p
SET "number" = 'PROP-' || LPAD(r.seq::text, 6, '0')
FROM ranked r
WHERE p.id = r.id;

ALTER TABLE "Property" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Property_number_key" ON "Property"("number");
