#!/usr/bin/env node
/**
 * migrate-tenants — run `prisma migrate deploy` against every non-
 * archived tenant's schema.
 *
 * Usage:
 *   pnpm --filter @loan/db migrate-tenants
 *   pnpm --filter @loan/db migrate-tenants --only acme-corp
 *   pnpm --filter @loan/db migrate-tenants --create-schema-if-missing
 *
 * When to run this:
 *   - After deploying a new release that includes schema migrations.
 *     Migrations only get applied to `public` automatically; this
 *     script walks the Tenant table and brings every per-tenant
 *     schema up to the same revision.
 *   - As part of CI's deploy step. Idempotent — re-running is safe.
 *
 * Doesn't run during single-tenant deploys (MULTI_TENANT !== "true")
 * unless --force is passed. In single-tenant mode there are no tenant
 * schemas, so there's nothing to migrate; running anyway would just
 * scan an empty Tenant table and exit.
 */

import { PrismaClient } from "@prisma/client";

// dist resolution: this file lives in libs/db/scripts/, and the
// runner is at libs/db/src/lib/multi-tenant-migrate.ts. We import via
// the workspace export so the source path is stable whether we're
// running from a built artifact or directly via tsx.
import {
  createTenantSchema,
  migrateTenantSchema,
} from "../src/lib/multi-tenant-migrate.ts";

const args = process.argv.slice(2);
const ONLY = takeArg("--only");
const CREATE_MISSING = args.includes("--create-schema-if-missing");
const FORCE = args.includes("--force");
const VERBOSE = args.includes("--verbose");

function takeArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function log(line, level = "info") {
  const ts = new Date().toISOString();
  const prefix = level === "error" ? "✗" : level === "warn" ? "!" : "·";
  process.stdout.write(`${ts} ${prefix} ${line}\n`);
}

async function main() {
  if (process.env.MULTI_TENANT !== "true" && !FORCE) {
    log(
      "MULTI_TENANT is not set to 'true'. Nothing to do in single-tenant mode. Pass --force to run anyway.",
      "warn",
    );
    return;
  }

  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: {
        status: { not: "ARCHIVED" },
        ...(ONLY ? { slug: ONLY } : {}),
      },
      select: { slug: true, status: true, name: true },
      orderBy: { createdAt: "asc" },
    });

    if (tenants.length === 0) {
      log(
        ONLY
          ? `No active tenant matches --only ${ONLY}`
          : "No active tenants to migrate",
        "warn",
      );
      return;
    }

    log(`Migrating ${tenants.length} tenant schema(s)`);

    const failures = [];
    for (const tenant of tenants) {
      log(`→ ${tenant.slug} (${tenant.status}, ${tenant.name})`);

      if (CREATE_MISSING) {
        try {
          await createTenantSchema(tenant.slug, prisma);
        } catch (err) {
          log(`  schema create failed: ${err.message}`, "error");
          failures.push({ slug: tenant.slug, error: err.message });
          continue;
        }
      }

      try {
        await migrateTenantSchema(tenant.slug, {
          logLine: VERBOSE
            ? (line, stream) =>
                process.stdout.write(`  [${tenant.slug}|${stream}] ${line}\n`)
            : () => {},
        });
        log(`  ✓ migrated`);
      } catch (err) {
        log(`  ✗ migrate failed: ${err.message}`, "error");
        failures.push({ slug: tenant.slug, error: err.message });
      }
    }

    if (failures.length > 0) {
      log(`Done with ${failures.length} failure(s):`, "error");
      for (const f of failures) {
        log(`  ${f.slug}: ${f.error}`, "error");
      }
      process.exit(1);
    }

    log(`Done. All ${tenants.length} tenant schema(s) up to date.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  log(err.stack ?? err.message, "error");
  process.exit(1);
});
