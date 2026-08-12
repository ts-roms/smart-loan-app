import type { JournalEntry, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { AccountingRepository } from "./accounting.repository";

/**
 * Invariant: a repeated auto-post creates no second journal entry.
 *
 * This is the first of the financial invariants named in
 * docs/modernization/test-coverage-audit.md (T-1), and it pins down the
 * P0 defect from the Phase 0 audit:
 *
 *   `postIfAbsent` read for an existing entry on
 *   (source, sourceRefType, sourceRefId) and posted if it found none.
 *   Nothing serialised the read against the write, and the tuple carried
 *   an index rather than a unique constraint — so two concurrent callers
 *   both found nothing and both posted. Each entry balanced on its own,
 *   so the trial balance still tied and no check the system performs
 *   could see the duplicate.
 *
 * The fix is the unique index; the code change is to stop treating the
 * lookup as the guarantee and instead let Postgres arbitrate, catching
 * P2002 and returning the winner's entry.
 *
 * These tests drive a stand-in for Prisma rather than a live database:
 * what is being asserted is the repository's *reaction* to a constraint
 * violation, which a real Postgres would raise but which we can provoke
 * deterministically here. The constraint itself is exercised by the
 * migration and by the detection script.
 */

const INPUT = {
  entryDate: new Date("2026-03-15T00:00:00.000Z"),
  memo: "Interest accrual",
  source: "INTEREST_ACCRUAL" as const,
  sourceRefType: "LoanSchedule",
  sourceRefId: "sched-1",
  lines: [
    { accountCode: "1200", debit: 100, credit: 0 },
    { accountCode: "4100", debit: 0, credit: 100 },
  ],
};

/** Prisma's shape for a unique-constraint violation. */
function uniqueViolation(): Error & { code: string } {
  const err = new Error(
    "Unique constraint failed on the fields: (`source`,`sourceRefType`,`sourceRefId`)",
  ) as Error & { code: string };
  err.code = "P2002";
  return err;
}

function entry(id: string): JournalEntry {
  return { id, number: `JE-2026-${id}` } as JournalEntry;
}

/**
 * Minimal Prisma stand-in. `findFirst` answers from `existing`, which the
 * test mutates to model another transaction committing mid-flight.
 */
function fakePrisma(opts: {
  existing: JournalEntry | null;
  onCreate: () => JournalEntry;
}) {
  const calls = { findFirst: 0, create: 0 };
  const client = {
    journalEntry: {
      findFirst: () => {
        calls.findFirst += 1;
        return Promise.resolve(opts.existing);
      },
    },
    __calls: calls,
  };
  return client as unknown as PrismaClient & { __calls: typeof calls };
}

describe("postIfAbsent — idempotency invariant", () => {
  it("returns the existing entry without posting when one is already there", async () => {
    const found = entry("first");
    const prisma = fakePrisma({
      existing: found,
      onCreate: () => entry("nope"),
    });
    const repo = new AccountingRepository(prisma);
    let posted = 0;
    // postEntry must never run: burning a journal number on an entry we
    // would immediately discard is itself a defect (gaps in JE numbering
    // read as deleted entries to an auditor).
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => {
        posted += 1;
        return Promise.resolve(entry("nope"));
      };

    const result = await repo.postIfAbsent(INPUT, { postedById: "u1" });

    expect(result.created).toBe(false);
    expect(result.entry.id).toBe("first");
    expect(posted).toBe(0);
  });

  it("posts when nothing exists yet", async () => {
    const prisma = fakePrisma({ existing: null, onCreate: () => entry("new") });
    const repo = new AccountingRepository(prisma);
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => Promise.resolve(entry("new"));

    const result = await repo.postIfAbsent(INPUT, { postedById: "u1" });

    expect(result.created).toBe(true);
    expect(result.entry.id).toBe("new");
  });

  it("loses the race gracefully: P2002 yields the winner, not a duplicate", async () => {
    /*
     * The exact interleaving that used to double-post. Our lookup runs
     * before the other transaction commits, so it sees nothing; by the
     * time we insert, the winner is there and Postgres rejects us.
     */
    const state: { existing: JournalEntry | null } = { existing: null };
    const prisma = {
      journalEntry: {
        findFirst: () => Promise.resolve(state.existing),
      },
    } as unknown as PrismaClient;
    const repo = new AccountingRepository(prisma);
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => {
        // The competing transaction commits between our read and our write.
        state.existing = entry("winner");
        return Promise.reject(uniqueViolation());
      };

    const result = await repo.postIfAbsent(INPUT, { postedById: "u1" });

    expect(result.created).toBe(false);
    expect(result.entry.id).toBe("winner");
  });

  it("rethrows a unique violation that is not the idempotency one", async () => {
    /*
     * A P2002 on the entry NUMBER is a real error — two posts racing for
     * the same JE-YYYY-NNNNNN. Swallowing it as idempotency would silently
     * drop a legitimate entry, so the absence of a matching row after the
     * violation must propagate.
     */
    const prisma = {
      journalEntry: { findFirst: () => Promise.resolve(null) },
    } as unknown as PrismaClient;
    const repo = new AccountingRepository(prisma);
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => Promise.reject(uniqueViolation());

    await expect(
      repo.postIfAbsent(INPUT, { postedById: "u1" }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it("does not swallow unrelated failures", async () => {
    const prisma = {
      journalEntry: { findFirst: () => Promise.resolve(null) },
    } as unknown as PrismaClient;
    const repo = new AccountingRepository(prisma);
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => Promise.reject(new Error("accounting period is closed"));

    await expect(
      repo.postIfAbsent(INPUT, { postedById: "u1" }),
    ).rejects.toThrow(/period is closed/);
  });

  it("skips the idempotency path entirely for manual entries", async () => {
    /*
     * A manual entry has no source reference. Postgres treats NULLs as
     * distinct, so the constraint does not apply and repeated manual
     * entries are legitimate — the repository must not look one up or
     * dedupe it.
     */
    let looked = 0;
    const prisma = {
      journalEntry: {
        findFirst: () => {
          looked += 1;
          return Promise.resolve(entry("should-not-be-used"));
        },
      },
    } as unknown as PrismaClient;
    const repo = new AccountingRepository(prisma);
    (repo as unknown as { postEntry: () => Promise<JournalEntry> }).postEntry =
      () => Promise.resolve(entry("manual"));

    const result = await repo.postIfAbsent(
      {
        ...INPUT,
        source: "MANUAL",
        sourceRefType: undefined,
        sourceRefId: undefined,
      },
      { postedById: "u1" },
    );

    expect(looked).toBe(0);
    expect(result.created).toBe(true);
    expect(result.entry.id).toBe("manual");
  });
});
