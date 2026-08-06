-- Did the co-maker ever open their consent link?
--
-- The co-maker equivalent of the presence heartbeat added for users,
-- and the closest this system can get for them: co-makers have no
-- account, so there is no session to observe. What CAN be observed is
-- whether the link they were sent was ever loaded.
--
-- This closes a real blind spot. A co-maker who hasn't answered blocks
-- disbursement, and until now the officer had no way to tell "they saw
-- it and are hesitating" from "it never reached them" — two situations
-- calling for completely different next moves: a phone call, or a
-- resend to a corrected number.
--
-- FIRST open, not most recent. Overwriting on every view would answer
-- "are they still looking", which nobody asks, and destroy "did it
-- arrive", which everybody does.

ALTER TABLE "CoMaker" ADD COLUMN "linkOpenedAt" TIMESTAMP(3);

-- Not indexed. It is read as part of a CoMaker row already fetched by
-- loan, and written at most once per issued link.
--
-- Left NULL for existing rows rather than backfilled from inviteSentAt.
-- "We sent it" is not "they opened it" — conflating the two is exactly
-- the confusion this column exists to remove.
