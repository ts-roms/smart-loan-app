-- Branding fields on SystemConfig. The shell, PDF letterheads, and
-- notification templates all read these at runtime — operators can
-- rebrand without a redeploy.
ALTER TABLE "SystemConfig"
  ADD COLUMN "companyName"    TEXT NOT NULL DEFAULT 'SmartLoan',
  ADD COLUMN "companyLogoUrl" TEXT,
  ADD COLUMN "companyTagline" TEXT,
  ADD COLUMN "companyAddress" TEXT,
  ADD COLUMN "companyPhone"   TEXT,
  ADD COLUMN "companyEmail"   TEXT,
  ADD COLUMN "companyWebsite" TEXT;
