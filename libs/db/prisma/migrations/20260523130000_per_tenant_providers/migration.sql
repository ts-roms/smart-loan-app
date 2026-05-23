-- Per-tenant notification provider credentials. Lets each cooperative
-- bring its own Twilio account / SendGrid API key instead of routing
-- through the vendor's shared upstream account. Two reasons this
-- matters:
--
--   1. Sender identity. SMS from "ACME-COOP" instead of "SMARTLOAN".
--   2. Billing isolation. The cooperative pays Twilio directly; the
--      vendor doesn't sit in the middle for SMS spend.
--
-- Credentials live in plaintext columns on SystemConfig, scoped to
-- the tenant's schema. The same DB-isolation that protects loan
-- data protects these (and a tenant admin's role catalog gates who
-- can read them). When a customer's security review demands
-- encryption-at-rest, swap in an AES-256-GCM column wrapper + a
-- platform-level master key — the column shape stays the same.
--
-- All fields nullable: when null, the platform's shared provider
-- handles the channel. When SystemConfig has any subset configured,
-- those channels switch to the tenant's own provider; the rest
-- continue using the platform fallback.

ALTER TABLE "SystemConfig"
  -- ── Twilio (SMS) ─────────────────────────────────────────────────
  ADD COLUMN "twilioAccountSid" TEXT,
  ADD COLUMN "twilioAuthToken"  TEXT,
  /// E.164 number or alphanumeric sender id ("ACME-COOP")
  ADD COLUMN "twilioFromNumber" TEXT,
  -- ── SendGrid (EMAIL) ─────────────────────────────────────────────
  ADD COLUMN "sendgridApiKey"    TEXT,
  /// Must be a verified sender on the SendGrid account
  ADD COLUMN "sendgridFromEmail" TEXT,
  ADD COLUMN "sendgridFromName"  TEXT;
