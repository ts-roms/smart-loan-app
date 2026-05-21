-- Add LOAN_APPROVAL_PENDING to the NotificationEvent enum so the dispatcher
-- can persist rows for "this loan needs your approval" alerts sent to the
-- next step's authorized approvers.
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'LOAN_APPROVAL_PENDING';
