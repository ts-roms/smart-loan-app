/**
 * Create / drop the write journey's scratch database.
 *
 * Run with tsx from `libs/db` (so `@prisma/client` resolves through the
 * generated client there):
 *
 *   DATABASE_URL=<postgres admin url> pnpm exec tsx <this file> create <name>
 *   DATABASE_URL=<postgres admin url> pnpm exec tsx <this file> drop   <name>
 *
 * DATABASE_URL must point at the `postgres` maintenance database on the
 * dev cluster — CREATE/DROP DATABASE cannot run against the database
 * being created or dropped.
 *
 * ── Why `.mjs` under `scripts/`, like every other operator script ────
 *
 * Because this reaches Prisma, and `apps/web` is `scope:browser`. The
 * `@nx/enforce-module-boundaries` rule bans that edge on purpose —
 * "no chain of legal edges gets from apps/web to Prisma" — and the ban
 * is right: nothing here belongs in a browser bundle. A `.ts` file in
 * this directory would be `apps/web` source importing `@loan/db`
 * (`scope:server`) and would fail lint, correctly. The repo already has
 * a home for scripts that are operator tooling rather than app code:
 * `**\/scripts/**\/*.mjs`, which the lint config skips for exactly this
 * reason (they belong to no tsconfig). `scripts/dev-license.mjs` is the
 * same shape.
 *
 * ── The guard (stolen from deploy/backup/restore.sh) ─────────────────
 *
 * This script REFUSES to touch any database whose name does not match
 * `smart_loan_e2e_<digits>`. That is a stronger position than
 * restore.sh's "not the configured one": there is no --force here,
 * because no legitimate call ever needs this script to drop anything
 * else. The dev database (`smart_loan`), a drill scratch
 * (`smart_loan_drill`), a typo — all fail the pattern and are refused
 * before a connection is even made.
 *
 * `drop` uses WITH (FORCE) for the same reason drill.sh does: the API
 * or Prisma pool may still hold a connection, and a DROP that blocks on
 * its own tidy-up is a silly way to hang a teardown.
 */
import { createPrismaClient } from "../../../../../libs/db/src/client.ts";

const SCRATCH_PATTERN = /^smart_loan_e2e_\d+$/;

async function main() {
  const [cmd, name] = process.argv.slice(2);
  if (
    (cmd !== "create" && cmd !== "drop" && cmd !== "list") ||
    (!name && cmd !== "list")
  ) {
    console.error(
      "Usage: db-admin.mjs <create|drop> <smart_loan_e2e_...> | list",
    );
    process.exit(2);
  }
  if (name && !SCRATCH_PATTERN.test(name)) {
    console.error(
      `REFUSING: "${name}" does not match ${SCRATCH_PATTERN}. ` +
        "This script only manages the write journey's disposable databases.",
    );
    process.exit(1);
  }
  const adminUrl = process.env.DATABASE_URL ?? "";
  if (!/\/postgres(\?|$)/.test(adminUrl)) {
    console.error(
      "DATABASE_URL must point at the `postgres` maintenance database.",
    );
    process.exit(2);
  }

  const prisma = createPrismaClient(adminUrl);
  try {
    if (cmd === "create") {
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      console.log(`created ${name}`);
    } else if (cmd === "drop") {
      await prisma.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      );
      console.log(`dropped ${name}`);
    }
    // Always report what scratch databases remain, so the caller (and
    // the run log) can see the lifecycle actually is clean.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT datname FROM pg_database WHERE datname LIKE 'smart_loan_e2e_%' ORDER BY datname`,
    );
    console.log(
      `remaining scratch databases: ${
        rows.length === 0 ? "none" : rows.map((r) => r.datname).join(", ")
      }`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
