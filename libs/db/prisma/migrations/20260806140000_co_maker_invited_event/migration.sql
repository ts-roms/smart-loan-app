-- The notification raised when a co-maker is asked to accept or
-- decline. Additive: existing rows keep their event unchanged.
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'CO_MAKER_INVITED';
