#!/usr/bin/env node
/**
 * Detect duplicate auto-posted journal entries — READ ONLY.
 *
 * `postIfAbsent` guards against double-posting by reading for an existing
 * entry on (source, sourceRefType, sourceRefId) and only posting if it
 * finds none. Nothing in the database enforced that: the tuple carried an
 * index, not a unique constraint. Two concurrent callers could therefore
 * both find nothing and both post, and because each entry balances on its
 * own the trial balance still ties — the duplicate is invisible to every
 * check the system performs.
 *
 * This script is the precondition for adding the unique constraint. Run it
 * before the migration: the constraint cannot be created while duplicates
 * exist, and finding out during `migrate deploy` on a production database
 * is the wrong moment.
 *
 * Writes nothing. Exit code 0 = clean, 1 = duplicates found (with a report).
 *
 *   node libs/db/scripts/detect-duplicate-journal-entries.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  /*
   * Grouped in SQL rather than pulled into memory: a mature ledger has
   * millions of lines, and the answer is a handful of rows.
   *
   * sourceRefId IS NOT NULL because that is exactly the set the guard
   * applies to — a manual entry has no source reference and is allowed to
   * repeat freely. Postgres also treats NULLs as distinct in a unique
   * index, so those rows are unaffected by the constraint this precedes.
   */
  const dupes = await prisma.$queryRaw`
    SELECT
      "source"::text        AS source,
      "sourceRefType"       AS ref_type,
      "sourceRefId"         AS ref_id,
      COUNT(*)::int         AS copies,
      MIN("postedAt")       AS first_posted,
      MAX("postedAt")       AS last_posted,
      ARRAY_AGG("number" ORDER BY "postedAt") AS entry_numbers
    FROM "JournalEntry"
    WHERE "sourceRefId" IS NOT NULL
    GROUP BY "source", "sourceRefType", "sourceRefId"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, MAX("postedAt") DESC
  `;

  const total = await prisma.journalEntry.count();
  const scoped = await prisma.journalEntry.count({
    where: { sourceRefId: { not: null } },
  });

  console.log(`Journal entries total          : ${total}`);
  console.log(`With a source reference (scope) : ${scoped}`);
  console.log(`Duplicate reference groups      : ${dupes.length}`);

  if (dupes.length === 0) {
    console.log("\nCLEAN — safe to add the unique constraint.");
    return 0;
  }

  console.log("\nDUPLICATES FOUND — resolve before migrating:\n");
  let extra = 0;
  for (const d of dupes) {
    extra += d.copies - 1;
    console.log(
      `  ${d.source} / ${d.ref_type ?? "-"} / ${d.ref_id}` +
        `\n    copies: ${d.copies}  entries: ${d.entry_numbers.join(", ")}` +
        `\n    first: ${d.first_posted.toISOString()}  last: ${d.last_posted.toISOString()}`,
    );
  }
  console.log(`\n${extra} redundant entr${extra === 1 ? "y" : "ies"} in total.`);
  console.log(
    "\nDo NOT delete them blindly. Each one has real ledger lines behind it;\n" +
      "the correct remedy is a reversing entry for the redundant copy, which\n" +
      "keeps the history auditable. Reverse, verify the trial balance, then\n" +
      "re-run this script.",
  );
  return 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Detection failed:", err.message);
    await prisma.$disconnect();
    process.exit(2);
  });
