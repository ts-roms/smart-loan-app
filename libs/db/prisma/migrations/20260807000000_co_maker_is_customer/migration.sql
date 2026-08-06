-- Co-makers are registered customers.
--
-- They used to be free text: a name and a phone number typed into a
-- box. That made a jointly-liable party invisible to everything this
-- system knows how to do — no KYC on file, no credit history, no way
-- to see the same person already guaranteeing four other loans, and no
-- way to tell two spellings of one name apart. A co-maker is
-- underwritten too, so they have to be someone we can look up.
--
-- NULLABLE, and that is deliberate. Existing rows were captured before
-- this existed and there is no honest way to guess which customer they
-- meant: matching on name would silently attach the wrong person to a
-- debt. New co-makers are required to carry one, enforced in the API
-- schema rather than by the column, so history stays readable instead
-- of becoming invalid.

ALTER TABLE "CoMaker" ADD COLUMN "customerId" TEXT;

-- ON DELETE RESTRICT, not CASCADE. Deleting a customer who stands as
-- co-maker on a live loan would quietly remove a party to that debt;
-- the delete has to fail loudly so someone decides what happens to the
-- loan first.
ALTER TABLE "CoMaker"
  ADD CONSTRAINT "CoMaker_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- "What else is this person guaranteeing?" — the exposure question,
-- which was unanswerable while co-makers were free text. Worth the
-- index because it is the reason for the whole change.
CREATE INDEX "CoMaker_customerId_idx" ON "CoMaker"("customerId");

-- The denormalised fullName / phone / email / address columns stay.
-- They are a snapshot, not a duplicate: the invite needs a number to
-- send to at that moment, and the consent record and signed agreement
-- must name the person who actually agreed. A customer editing their
-- phone next year must not rewrite what a co-maker signed.
