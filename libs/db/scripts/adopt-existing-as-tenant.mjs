#!/usr/bin/env node
/**
 * adopt-existing-as-tenant — one-time migration that moves an existing
 * single-tenant deployment's data into a `tenant_<slug>` schema, so the
 * deployment can flip to `MULTI_TENANT=true` without losing anything.
 *
 * Usage:
 *   pnpm --filter @loan/db adopt-existing-as-tenant \
 *     --slug acme-coop \
 *     --name "Acme Cooperative" \
 *     --platform-admin-email ops@vendor.com \
 *     --platform-admin-name "Vendor Ops" \
 *     --confirm-slug acme-coop
 *
 * Flow:
 *   1. Pre-flight checks (no existing tenant_<slug>, public has data,
 *      Tenant table is empty).
 *   2. `pg_dump` backup of the current public schema to ./backups/.
 *   3. ALTER SCHEMA public RENAME TO tenant_<slug>; CREATE SCHEMA public.
 *   4. `prisma migrate deploy` against the fresh public schema.
 *   5. Insert a Tenant row + bootstrap PlatformUser. The temp password
 *      is printed once on stdout — copy it out, then change it after
 *      first login.
 *
 * Safety:
 *   - --confirm-slug must equal --slug (typed-confirmation gate so a
 *     stray invocation doesn't rename anything).
 *   - --skip-backup is supported but loudly warns. Only use when you
 *     have a separate backup pipeline.
 *
 * @see docs/multi-tenant-cutover.md §2.B
 */

import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../../auth/src/password.ts";
import { adoptExistingAsTenant } from "../src/lib/adopt-existing.ts";

const args = process.argv.slice(2);
const SLUG = takeArg("--slug");
const NAME = takeArg("--name");
const ADMIN_EMAIL = takeArg("--platform-admin-email");
const ADMIN_NAME = takeArg("--platform-admin-name");
const CONFIRM_SLUG = takeArg("--confirm-slug");
const BACKUP_DIR = takeArg("--backup-dir");
const SKIP_BACKUP = args.includes("--skip-backup");
const VERBOSE = args.includes("--verbose");

function takeArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function log(line, level = "info") {
  const ts = new Date().toISOString();
  const prefix = level === "error" ? "✗" : level === "warn" ? "!" : "·";
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${ts} ${prefix} ${line}\n`);
}

function usage() {
  process.stderr.write(
    [
      "Usage: adopt-existing-as-tenant --slug <slug> --name <name> \\",
      "         --platform-admin-email <email> --platform-admin-name <name> \\",
      "         --confirm-slug <slug> [--backup-dir <path>] [--skip-backup] [--verbose]",
      "",
      "All four required flags must be supplied. --confirm-slug must equal --slug.",
    ].join("\n") + "\n",
  );
  process.exit(2);
}

async function main() {
  if (!SLUG || !NAME || !ADMIN_EMAIL || !ADMIN_NAME || !CONFIRM_SLUG) {
    usage();
  }
  if (SLUG !== CONFIRM_SLUG) {
    log(
      `--confirm-slug (${JSON.stringify(CONFIRM_SLUG)}) does not match --slug (${JSON.stringify(SLUG)}). Refusing to proceed.`,
      "error",
    );
    process.exit(2);
  }

  log(`Adoption target: slug=${SLUG}, name=${NAME}`);
  log(
    `Platform admin: ${ADMIN_NAME} <${ADMIN_EMAIL}> (will be created with PLATFORM_ADMIN role)`,
  );
  if (SKIP_BACKUP) {
    log(
      "⚠ --skip-backup set. pg_dump will NOT run before the rename. Make sure you have an external backup.",
      "warn",
    );
  }

  const prisma = new PrismaClient();
  try {
    const result = await adoptExistingAsTenant(prisma, {
      slug: SLUG,
      name: NAME,
      platformAdminEmail: ADMIN_EMAIL,
      platformAdminName: ADMIN_NAME,
      hashPassword,
      backupDir: BACKUP_DIR ?? undefined,
      skipBackup: SKIP_BACKUP,
      logLine: VERBOSE
        ? (line, stream) => process.stdout.write(`  [${stream}] ${line}\n`)
        : () => {},
    });

    log(``);
    log(`✓ adoption complete`);
    if (result.backupPath) log(`  backup:        ${result.backupPath}`);
    log(`  tenant slug:   ${result.slug}`);
    log(`  platform admin: ${ADMIN_EMAIL}`);
    log(`  temp password: ${result.platformAdminTempPassword}`);
    log(``);
    log(`Next steps:`);
    log(`  1. Save the temp password somewhere safe. It WILL NOT be shown again.`);
    log(`  2. Set MULTI_TENANT=true in your .env and restart the API.`);
    log(
      `  3. Log into the platform console with the email + temp password above and change the password.`,
    );
    log(
      `  4. Tenant users (the ones already in your DB) keep their existing credentials but need to sign in via /login?tenant=${SLUG}.`,
    );
  } catch (err) {
    log(err.stack ?? err.message ?? String(err), "error");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  log(err.stack ?? err.message ?? String(err), "error");
  process.exit(1);
});
