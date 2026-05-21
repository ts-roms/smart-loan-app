-- Idle-then-logout policy lives on SystemConfig so admins can change
-- it without redeploying. Defaults are 60s idle + 60s warning — the
-- safe-side choice for a financial app where short sessions reduce
-- shoulder-surfing risk. Anyone who finds the default too aggressive
-- can extend (up to the API-enforced max) from /settings.

ALTER TABLE "SystemConfig"
  ADD COLUMN "idleTimeoutSeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "idleWarningSeconds" INTEGER NOT NULL DEFAULT 60;
