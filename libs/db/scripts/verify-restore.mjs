#!/usr/bin/env node
/**
 * verify-restore — prove a restored database is the database that was
 * backed up. READ ONLY, both modes.
 *
 * A restore that ran without error is not a restore that worked. psql
 * will happily replay a truncated dump, `--clean --if-exists` will
 * happily drop tables it then fails to refill, and the result is a
 * database that connects, serves pages, and is missing three weeks of
 * payments. Nothing in the restore path notices, because nothing in the
 * restore path knows what the answer was supposed to be.
 *
 * So the drill has two halves, and they must straddle the backup:
 *
 *   --record BASELINE   before backup.sh runs, against the SOURCE
 *   --verify BASELINE   after restore.sh runs, against the TARGET
 *
 * What is compared:
 *
 *   1. Row counts, per table. The financial tables (see LEDGER below)
 *      are hard failures; everything else is reported as drift. That
 *      split is not laziness — RefreshToken, AuditEvent, JobRun and
 *      Notification are written by the running system between the
 *      baseline and the dump, so failing on them would make the drill
 *      fail for reasons that have nothing to do with the backup, and a
 *      drill that cries wolf is a drill that gets skipped.
 *
 *   2. Reconciliation — the five checks in libs/db/src/lib/reconciliation.ts,
 *      re-run against the RESTORED database. Row counts prove the rows
 *      arrived; reconciliation proves they still mean something. A dump
 *      restored with a truncated JournalLine table has the trial balance
 *      out by the missing side, and no count comparison of JournalEntry
 *      alone would see it.
 *
 *   3. Uploads, when --uploads is passed. File count, total bytes and a
 *      digest over the sorted path:size manifest. The database holds
 *      paths, not documents; without this, "verified" means the metadata
 *      for a KYC file that is not there.
 *
 * The restore is verified only if all three agree AND reconciliation
 * returns ok. Exit code 0 = verified, 1 = not verified.
 *
 * Usage:
 *   # before the backup, against the live database
 *   DATABASE_URL=... tsx scripts/verify-restore.mjs \
 *     --record /tmp/baseline.json --uploads /srv/uploads
 *
 *   # after the restore, against the scratch database
 *   DATABASE_URL=...scratch tsx scripts/verify-restore.mjs \
 *     --verify /tmp/baseline.json --uploads /tmp/uploads-restored
 *
 * Options:
 *   --record FILE     write a baseline
 *   --verify FILE     read a baseline and compare
 *   --uploads DIR     include the uploads tree
 *   --schema NAME     schema to count (default: public)
 *   --json            machine-readable result on stdout
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { PrismaClient } from "@prisma/client";
import { runReconciliation } from "../src/lib/reconciliation.ts";

/*
 * Tables whose counts are a hard failure if they differ.
 *
 * The rule: a row here represents money, an obligation, or the identity
 * of the party on the other side of one. Losing one silently is the
 * failure mode this whole document exists for. Everything not listed is
 * either derived, operational, or written continuously by the running
 * system.
 */
const LEDGER = [
  // The general ledger itself
  "Account",
  "AccountingPeriod",
  "JournalEntry",
  "JournalLine",
  // The loan book
  "Customer",
  "LoanProduct",
  "LoanApplication",
  "LoanSchedule",
  "LoanPayment",
  "PaymentIntent",
  "PenaltyWaiver",
  // Money that is not a loan
  "SavingsTransaction",
  "Contribution",
  "FundTransaction",
  "FundWithdrawal",
  "Expense",
  "OtherIncome",
  "AgentPayout",
  "AgentPayoutItem",
  // Collateral and recovery — the paperwork behind a claim
  "LeaseAgreement",
  "RepossessionCase",
  "Vehicle",
  "Property",
  "CoMaker",
  // Bank side
  "BankStatement",
  "BankStatementLine",
  // Who is allowed to touch any of the above
  "User",
  "Role",
  "Permission",
  "RolePermission",
  "Tenant",
];

function parseArgs(argv) {
  const opts = { schema: "public", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--record") opts.record = argv[++i];
    else if (a === "--verify") opts.verify = argv[++i];
    else if (a === "--uploads") opts.uploads = argv[++i];
    else if (a === "--schema") opts.schema = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Count every base table in one round trip.
 *
 * query_to_xml is the standard way to run a dynamic count per table
 * without a PL/pgSQL function or 74 separate queries. It matters that
 * this is generic: a hand-maintained list would silently stop covering
 * whatever table the next migration adds, and the tables nobody
 * remembers to add are exactly the ones a partial restore loses.
 */
async function countTables(prisma, schema) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT c.relname::text AS table_name,
           (xpath('/row/cnt/text()',
              query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS n
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r'
    ORDER BY 1
    `,
    schema,
  );
  const counts = {};
  for (const r of rows) counts[r.table_name] = Number(r.n);
  return counts;
}

/** Every file under root, as sorted "relative/path:bytes" lines. */
function walkUploads(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  // POSIX separators so a baseline recorded on one host verifies on
  // another — the drill is meant to be run from a laptop against a
  // dump taken on a Linux server.
  const lines = files
    .map((f) => `${relative(root, f).split(sep).join("/")}:${statSync(f).size}`)
    .sort();
  return {
    files: lines.length,
    bytes: lines.reduce(
      (sum, l) => sum + Number(l.slice(l.lastIndexOf(":") + 1)),
      0,
    ),
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}

async function snapshot(prisma, opts) {
  const counts = await countTables(prisma, opts.schema);
  const recon = await runReconciliation(prisma);
  const snap = {
    takenAt: new Date().toISOString(),
    schema: opts.schema,
    database: (await prisma.$queryRaw`SELECT current_database() AS db`)[0].db,
    counts,
    reconciliation: recon,
  };
  if (opts.uploads) snap.uploads = walkUploads(opts.uploads);
  return snap;
}

function compare(baseline, current) {
  const failures = [];
  const drift = [];

  const tables = new Set([
    ...Object.keys(baseline.counts),
    ...Object.keys(current.counts),
  ]);
  for (const t of [...tables].sort()) {
    const was = baseline.counts[t];
    const now = current.counts[t];
    if (was === now) continue;
    const line = `${t}: baseline ${was ?? "(table absent)"} → restored ${now ?? "(table absent)"}`;
    if (LEDGER.includes(t) || was === undefined || now === undefined) {
      failures.push(line);
    } else {
      drift.push(line);
    }
  }

  if (baseline.uploads && current.uploads) {
    const b = baseline.uploads;
    const c = current.uploads;
    if (b.digest !== c.digest) {
      failures.push(
        `uploads: baseline ${b.files} file(s) / ${b.bytes} bytes → restored ${c.files} file(s) / ${c.bytes} bytes (manifest digest differs)`,
      );
    }
  } else if (baseline.uploads && !current.uploads) {
    failures.push(
      `uploads: baseline recorded ${baseline.uploads.files} file(s) but --uploads was not passed to --verify, so the files were not checked`,
    );
  }

  return { failures, drift };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.record && !opts.verify)) {
    // The header comment IS the help text — printed by scanning for the
    // end of the block rather than a line count, so editing the comment
    // cannot silently truncate the help.
    const src = readFileSync(new URL(import.meta.url), "utf8").split("\n");
    const end = src.findIndex((l) => l.trim() === "*/");
    console.log(src.slice(1, end === -1 ? 40 : end + 1).join("\n"));
    process.exit(opts.help ? 0 : 2);
  }

  const prisma = new PrismaClient();
  try {
    const current = await snapshot(prisma, opts);

    if (opts.record) {
      writeFileSync(opts.record, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`Baseline written to ${opts.record}`);
      console.log(`  database:   ${current.database}`);
      console.log(
        `  tables:     ${Object.keys(current.counts).length} (${Object.values(current.counts).reduce((a, b) => a + b, 0)} rows)`,
      );
      if (current.uploads) {
        console.log(
          `  uploads:    ${current.uploads.files} file(s), ${current.uploads.bytes} bytes`,
        );
      }
      /*
       * A baseline taken from a source that does not reconcile is worth
       * recording — you cannot fix the ledger from the backup script —
       * but say so, because otherwise the drill later "fails" and the
       * finding gets blamed on the restore.
       */
      console.log(
        `  ledger:     ${current.reconciliation.ok ? "reconciles" : "DOES NOT RECONCILE — the drill will inherit this"}`,
      );
      for (const c of current.reconciliation.checks) {
        console.log(`    ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.summary}`);
      }
      if (opts.json) console.log(JSON.stringify(current));
      return 0;
    }

    if (!existsSync(opts.verify)) {
      // A stack trace here reads as a broken script. It is nearly always
      // the drill's two halves run against different working
      // directories, or --record never having been run at all.
      console.error(`No baseline at ${opts.verify}.`);
      console.error(
        `Take one with --record BEFORE the backup runs; a baseline taken after the restore proves nothing.`,
      );
      return 1;
    }
    const baseline = JSON.parse(readFileSync(opts.verify, "utf8"));
    const { failures, drift } = compare(baseline, current);

    console.log(`Restore verification`);
    console.log(`  baseline:   ${baseline.database} @ ${baseline.takenAt}`);
    console.log(`  restored:   ${current.database} @ ${current.takenAt}`);
    console.log("");
    console.log(`  Row counts`);
    if (failures.length === 0) {
      console.log(
        `    ok   every financial table matches (${LEDGER.length} checked, ${Object.keys(current.counts).length} tables total)`,
      );
    }
    for (const f of failures) console.log(`    FAIL ${f}`);
    for (const d of drift) console.log(`    drift ${d}`);

    console.log("");
    console.log(`  Reconciliation on the RESTORED database`);
    for (const c of current.reconciliation.checks) {
      console.log(`    ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.summary}`);
      for (const o of c.offenders ?? []) console.log(`         ${o}`);
    }

    if (baseline.uploads && current.uploads) {
      console.log("");
      console.log(`  Uploads`);
      console.log(
        `    ${baseline.uploads.digest === current.uploads.digest ? "ok  " : "FAIL"} ${current.uploads.files} file(s), ${current.uploads.bytes} bytes`,
      );
    }

    const verified = failures.length === 0 && current.reconciliation.ok;
    console.log("");
    console.log(
      verified
        ? "  VERIFIED — the restored database holds the same book as the source."
        : "  NOT VERIFIED — do not treat this backup as a working backup.",
    );
    if (opts.json) {
      console.log(JSON.stringify({ verified, failures, drift, current }));
    }
    return verified ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
