-- Customer-facing "your statement is ready" notification, fired by the
-- operator from the Customer Ledger panel. No PDF attachment is sent —
-- customer logs into the portal to view and download.
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'STATEMENT_READY';
