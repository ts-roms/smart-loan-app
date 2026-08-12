-- Idempotency for auto-posted journal entries, enforced by the database.
--
-- `postIfAbsent` checked for an existing entry on this tuple and posted if
-- it found none. Nothing serialised the check against the post, so two
-- concurrent callers could both find nothing and both post. Each entry
-- balances internally, so the trial balance still tied and no existing
-- check could detect the duplicate.
--
-- Run libs/db/scripts/detect-duplicate-journal-entries.mjs BEFORE applying
-- this. The index cannot be created while duplicates exist, and the right
-- remedy for any that are found is a reversing entry, not a delete.
--
-- NULLs are distinct in a Postgres unique index, so manual entries
-- (sourceRefId IS NULL) are unaffected and may repeat freely.
CREATE UNIQUE INDEX "journal_source_ref_unique"
  ON "JournalEntry" ("source", "sourceRefType", "sourceRefId");
