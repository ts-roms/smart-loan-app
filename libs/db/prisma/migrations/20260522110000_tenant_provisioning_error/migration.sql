-- Tenant.provisioningError — captures the most recent provisioning
-- failure so the platform console can surface it without trawling
-- logs. Cleared automatically when the next provisioning attempt
-- succeeds (status flips to ACTIVE).

ALTER TABLE "Tenant"
  ADD COLUMN "provisioningError" TEXT;
