#!/usr/bin/env node
/**
 * sweep-orphaned-entries — find journal entries whose source row is gone.
 *
 * `JournalEntry.sourceRefId` is a plain string with no foreign key, and
 * deliberately so: a general ledger is meant to be immutable. You reverse
 * an entry, you never delete it, and a FK that cascaded would let deleting
 * a loan quietly rewrite the books.
 *
 * That is right in production, where nothing deletes a loan. It is wrong
 * in a development database, where `docs/smoke-tests/fixtures.ts` deletes
 * and recreates its loans on every run. The entries outlive their loans
 * and go on asserting balances with nothing behind them — one sweep of
 * this repo's dev database found ₱462,261.92 sitting on 18 entries whose
 * loans and payments no longer existed, including ₱600 of Customer
 * Advance Payments owed to nobody.
 *
 * The fixture no longer leaves them behind (it clears the entries before
 * deleting the loans), but that only helps future runs. This clears what
 * is already there.
 *
 * Usage:
 *   pnpm --filter @loan/db sweep-orphans                 # dry run
 *   pnpm --filter @loan/db sweep-orphans --apply
 *   pnpm --filter @loan/db sweep-orphans --all-tenants
 *   pnpm --filter @loan/db sweep-orphans --only acme-corp
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply.
 *
 * DELETED, not reversed — and that is the one judgement call here. A
 * reversal says "this happened and was wrong". These entries describe
 * events whose subject no longer exists, so there is nothing to reverse
 * against and a reversal would only double the noise. Deleting whole
 * entries (never individual lines) also keeps the trial balance
 * balanced, because each entry balances on its own.
 *
 * REFUSES TO RUN when it cannot tell an orphan from a legitimately
 * unlinked entry — see UNMAPPED below. Guessing here would delete real
 * bookkeeping.
 */

import { PrismaClient } from "@prisma/client";

import { tenantDatabaseUrl } from "../src/lib/multi-tenant-migrate.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL_TENANTS = args.includes("--all-tenants");
const ONLY = takeArg("--only");

function takeArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function log(line, level = "info") {
  const prefix = level === "error" ? "✗" : level === "warn" ? "!" : "·";
  process.stdout.write(`${prefix} ${line}\n`);
}

/**
 * Which table each `sourceRefType` points at.
 *
 * Every value the codebase writes has to appear here. A type that is
 * missing is reported and SKIPPED rather than assumed orphaned: an
 * unmapped type means this script does not know where to look, and
 * "I couldn't find the owner" must never be read as "the owner is gone".
 */
const OWNER_TABLE = {
  LoanApplication: "LoanApplication",
  LoanPayment: "LoanPayment",
  LoanRestructure: "LoanApplication",
  LoanPreTermination: "LoanApplication",
  LoanWriteOff: "LoanApplication",
  LoanScheduleAccrual: "LoanSchedule",
  LoanScheduleLateFee: "LoanSchedule",
  LoanPaymentAllocationRepair: "LoanApplication",
  AgentCommission: "LoanApplication",
  AgentPayout: "AgentPayout",
  PenaltyWaiver: "PenaltyWaiver",
  Contribution: "Contribution",
  FundTransaction: "FundTransaction",
  FundWithdrawal: "FundTransaction",
  Expense: "Expense",
  OtherIncome: "OtherIncome",
  BigBrotherAccount: "BigBrotherAccount",
  LeaseAgreement: "LeaseAgreement",
  EclRun: "EclRun",
  /*
   * A reversal points at the entry it reverses, which lives in the same
   * table. Included so reversals are checked too — a reversal whose
   * original was swept is itself an orphan, and leaving it would restate
   * a balance that no longer has an opposite.
   */
  JournalEntry: "JournalEntry",
};

async function sweepSchema(prisma, label) {
  log(`── ${label}`);

  const types = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "sourceRefType" AS t FROM "JournalEntry"
     WHERE "sourceRefType" IS NOT NULL AND "sourceRefId" IS NOT NULL`,
  );

  const unmapped = types.map((r) => r.t).filter((t) => !OWNER_TABLE[t]);
  if (unmapped.length > 0) {
    log(
      `Unknown sourceRefType(s): ${unmapped.join(", ")}. Add them to OWNER_TABLE before sweeping — this script will not guess whether they are orphaned.`,
      "error",
    );
    return { refused: true };
  }

  const orphans = [];
  for (const { t } of types) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT e.id, e."entryDate", e.memo, e."reversedById",
              COALESCE(SUM(l.debit), 0) AS total
       FROM "JournalEntry" e
       LEFT JOIN "${OWNER_TABLE[t]}" o ON o.id = e."sourceRefId"
       LEFT JOIN "JournalLine" l ON l."entryId" = e.id
       WHERE e."sourceRefType" = $1 AND o.id IS NULL
       GROUP BY e.id, e."entryDate", e.memo, e."reversedById"
       ORDER BY e."entryDate"`,
      t,
    );
    for (const r of rows) orphans.push({ ...r, type: t });
  }

  if (orphans.length === 0) {
    log("No orphaned entries.");
    return { orphans: [] };
  }

  let value = 0;
  for (const o of orphans) {
    value += Number(o.total);
    log(
      `  ${o.entryDate.toISOString().slice(0, 10)}  ${o.type.padEnd(22)} ${String(o.memo ?? "").slice(0, 46).padEnd(46)} ₱${Number(o.total).toFixed(2)}`,
    );
  }
  log(
    `${orphans.length} orphaned entries carrying ₱${value.toFixed(2)} of ledger value.`,
    "warn",
  );

  if (!APPLY) {
    log("Dry run — nothing written. Re-run with --apply.");
    return { orphans };
  }

  const ids = orphans.map((o) => o.id);
  await prisma.$transaction(async (tx) => {
    /*
     * Break the reversal link first. `reversedById` is a self-FK, so
     * deleting an original and its reversal in one statement fails on
     * whichever side goes first — and a half-deleted pair is worse than
     * the orphan was.
     */
    await tx.journalEntry.updateMany({
      where: { id: { in: ids } },
      data: { reversedById: null },
    });
    await tx.journalLine.deleteMany({ where: { entryId: { in: ids } } });
    await tx.journalEntry.deleteMany({ where: { id: { in: ids } } });
  });
  log(`Deleted ${ids.length} orphaned entries.`);
  return { orphans, deleted: ids.length };
}

/** Debits must still equal credits once the sweep is done. */
async function trialBalance(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
     FROM "JournalLine"`,
  );
  const dr = Number(rows[0].dr);
  const cr = Number(rows[0].cr);
  return { dr, cr, balanced: Math.abs(dr - cr) < 0.005 };
}

async function run(prisma, label) {
  const before = await trialBalance(prisma);
  const result = await sweepSchema(prisma, label);
  if (result.refused) {
    process.exitCode = 1;
    return;
  }
  const after = await trialBalance(prisma);
  log(
    `Trial balance ${before.balanced ? "balanced" : "OUT OF BALANCE"} before, ${after.balanced ? "balanced" : "OUT OF BALANCE"} after (Dr ${after.dr.toFixed(2)} / Cr ${after.cr.toFixed(2)}).`,
    after.balanced ? "info" : "error",
  );
  if (!after.balanced) process.exitCode = 1;
}

async function main() {
  if (!ALL_TENANTS && !ONLY) {
    const prisma = new PrismaClient();
    try {
      await run(prisma, "default schema");
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const control = new PrismaClient();
  let tenants;
  try {
    tenants = await control.tenant.findMany({
      where: ONLY ? { slug: ONLY } : { status: { not: "ARCHIVED" } },
      select: { slug: true, name: true },
      orderBy: { slug: "asc" },
    });
  } finally {
    await control.$disconnect();
  }
  if (tenants.length === 0) {
    log(ONLY ? `No tenant with slug "${ONLY}".` : "No tenants.", "warn");
    return;
  }
  const base = process.env.DATABASE_URL;
  if (!base) {
    log("DATABASE_URL is not set.", "error");
    process.exitCode = 1;
    return;
  }
  for (const tenant of tenants) {
    const prisma = new PrismaClient({
      datasources: {
        db: { url: tenantDatabaseUrl(base, tenant.slug, { connectionLimit: 2 }) },
      },
    });
    try {
      await run(prisma, `${tenant.slug} (${tenant.name})`);
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((err) => {
  log(err?.stack ?? String(err), "error");
  process.exitCode = 1;
});
