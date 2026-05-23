-- Data-retention policy. Three knobs on SystemConfig drive the nightly
-- `data-retention-purge` job:
--
--   - auditRetentionDays         default 1825  (5 years — AMLA §9 floor)
--   - notificationRetentionDays  default 365   (operational; less regulated)
--   - jobRunRetentionDays        default 90    (purely operational telemetry)
--
-- 0 means "never purge" — a deliberate operator opt-out. The audit row
-- retention default tracks the AMLA + BSP Circular 706 minimum; setting
-- it lower than 1825 days is allowed but the platform console surfaces
-- a warning ("retention below regulatory minimum").
--
-- See apps/api/src/features/compliance/retention.service.ts for the
-- purge logic and the job definition in apps/api/src/jobs.ts.

ALTER TABLE "SystemConfig"
  ADD COLUMN "auditRetentionDays"        INTEGER NOT NULL DEFAULT 1825,
  ADD COLUMN "notificationRetentionDays" INTEGER NOT NULL DEFAULT 365,
  ADD COLUMN "jobRunRetentionDays"       INTEGER NOT NULL DEFAULT 90;
