-- Coop money survives its member.
--
-- Contribution and SavingsTransaction cascaded from Customer. A member
-- who had saved for years and never borrowed was therefore deletable —
-- LoanApplication and CoMaker are RESTRICT and would have refused, but
-- a member with no loan has neither — and deleting them took every
-- contribution and savings movement with them, silently, while the cash
-- stayed in the cooperative's bank account.
--
-- The application layer stopped deleting customers entirely (archiving
-- replaced it), so this closes the gap between what the service
-- promises and what the database permits. RESTRICT makes the promise
-- structural: a code path that has not been written yet, or a
-- hand-typed DELETE, now fails loudly instead of destroying money.
--
-- Safe to apply: nothing in the codebase deletes a Customer, and the
-- smoke-test fixtures create no contributions or savings.
--
-- Rollback: re-run these two statements with ON DELETE CASCADE.
ALTER TABLE "Contribution"
  DROP CONSTRAINT "Contribution_customerId_fkey",
  ADD CONSTRAINT "Contribution_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SavingsTransaction"
  DROP CONSTRAINT "SavingsTransaction_customerId_fkey",
  ADD CONSTRAINT "SavingsTransaction_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
