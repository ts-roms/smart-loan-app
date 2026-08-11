-- Payment idempotency.
--
-- A retried payment request created a second real payment: the endpoint
-- validated the loan status and wrote, with no duplicate detection. The
-- borrower's balance was then wrong in their favour against cash that
-- never existed. A timeout the caller never saw, a double-submitted
-- form, or an at-least-once provider callback were all enough.
--
-- Opt-in and nullable: callers that send no key behave exactly as
-- before, and NULLs are distinct in a Postgres unique index so they
-- never collide with one another.
ALTER TABLE "LoanPayment" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "LoanPayment_idempotencyKey_key"
  ON "LoanPayment" ("idempotencyKey");
