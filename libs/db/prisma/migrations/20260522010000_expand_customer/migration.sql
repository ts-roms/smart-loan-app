-- ──────────────────────────────────────────────────────────────────────
-- Expand Customer schema to capture PH-standard registration fields:
--   • Personal:    suffix, gender, sex, civilStatus
--   • Contact:     secondaryPhone
--   • Address:     addressLine2, barangay, region
--   • Spouse:      spouseName, spouseDateOfBirth, spouseContact,
--                  spouseOccupation (only populated when MARRIED)
--   • Employment:  position, hireDate, regularizationDate
--
-- All additions are nullable so existing rows survive untouched. A new
-- `FREELANCE` value joins the EmploymentStatus enum for the gig-worker
-- bucket FRD §1.6 treats distinctly from SELF_EMPLOYED.
-- ──────────────────────────────────────────────────────────────────────

-- New enums
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY');
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'INTERSEX');
CREATE TYPE "CivilStatus" AS ENUM ('SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED', 'ANNULLED', 'DIVORCED');

-- Add the FREELANCE value to the existing EmploymentStatus enum.
ALTER TYPE "EmploymentStatus" ADD VALUE IF NOT EXISTS 'FREELANCE';

-- Personal
ALTER TABLE "Customer"
  ADD COLUMN "suffix"           TEXT,
  ADD COLUMN "gender"           "Gender",
  ADD COLUMN "sex"              "Sex",
  ADD COLUMN "civilStatus"      "CivilStatus";

-- Contact
ALTER TABLE "Customer"
  ADD COLUMN "secondaryPhone"   TEXT;

-- Expanded address (PSGC hierarchy)
ALTER TABLE "Customer"
  ADD COLUMN "addressLine2"     TEXT,
  ADD COLUMN "barangay"         TEXT,
  ADD COLUMN "region"           TEXT;

-- Spouse details — populated only when civilStatus = MARRIED
ALTER TABLE "Customer"
  ADD COLUMN "spouseName"         TEXT,
  ADD COLUMN "spouseDateOfBirth"  TIMESTAMP(3),
  ADD COLUMN "spouseContact"      TEXT,
  ADD COLUMN "spouseOccupation"   TEXT;

-- Employment extras (PH labour milestones + designation)
ALTER TABLE "Customer"
  ADD COLUMN "position"             TEXT,
  ADD COLUMN "hireDate"             TIMESTAMP(3),
  ADD COLUMN "regularizationDate"   TIMESTAMP(3);
