import "dotenv/config";
import {
  AccountingRepository,
  PermissionRepository,
  RoleRepository,
  ScoringCatalogRepository,
} from "@loan/db";

import { buildApp } from "./app";
import { config, validateConfig } from "./config";

const app = await buildApp();

// Validate AFTER app is built so we have a logger to report into.
// In production this hard-fails on critical issues (default JWT secret,
// missing provider credentials, etc.). In dev it just warns.
validateConfig(app.log);

/*
 * Reconcile the RBAC catalog with the code, the same way migrations
 * reconcile the schema: on every boot, before traffic.
 *
 * Migrations run in the start script, so a deploy always carries its
 * tables — but nothing carried its PERMISSIONS. A permission key ships
 * in code, the UI gates a whole module on it, and the deployed
 * database has no row for it, so `/auth/me/permissions` omits it and
 * the module hides from everyone including the admin. That is exactly
 * how the agents module deployed successfully and then did not exist:
 * the only paths that wrote the catalog were the local seed script and
 * a `/sync` endpoint nothing in the UI calls.
 *
 * Same writes as that endpoint: upsert the permission catalog,
 * reconcile the SYSTEM roles' grants to code defaults. Custom roles
 * are never touched. Idempotent, so a restart is a no-op.
 *
 * Failure logs loudly and boots anyway. The alternative is a
 * crash-loop on a transient DB error, and a stale catalog — today's
 * status quo — is strictly better than no API. The log line names the
 * consequence so the operator knows what "stale" means here.
 *
 * The chart of accounts has exactly the same problem and is reconciled
 * here for exactly the same reason. It was written only by tenant
 * provisioning and a manual admin endpoint, so a deploy that adds an
 * account code shipped the code that POSTS to it without the row it
 * posts to — and `postEntry` throws "Unknown account code" rather than
 * degrading. A bad-debt recovery would have failed outright on any
 * database provisioned before 4300 existed. Upsert-only: it adds what
 * is missing and never deletes or renames what an accountant has
 * customised.
 *
 * The scoring catalog's BASELINE version is minted here too, and for a
 * reason particular to it: the snapshot has to be the shape
 * @loan/credit-scoring consumes, fallback included, so it cannot be
 * written by the migration without duplicating that mapping in SQL. A
 * deployment that scored a borrower before the baseline existed would
 * stamp a null version — recoverable, but a null nobody can later fill
 * in, so it is worth minting before the first request rather than on
 * the first edit.
 *
 * Multi-tenant note: this reconciles the DEFAULT schema only, matching
 * what boot can know before any JWT names a tenant. Per-tenant schemas
 * still use POST /admin/rbac/sync and POST /accounting/chart/seed.
 */
try {
  const perms = await new PermissionRepository(app.prisma).seed();
  const roles = await new RoleRepository(app.prisma).seedDefaults();
  const chart = await new AccountingRepository(app.prisma).seedDefaultChart();
  const scorecard = await new ScoringCatalogRepository(
    app.prisma,
  ).ensureBaseline();
  app.log.info(
    `RBAC catalog reconciled: ${perms.created} permission(s) created (${perms.existing} existing), ${roles.created} role(s) created (${roles.existing} reconciled); chart: ${chart.created} account(s) created (${chart.existing} existing); scorecard at v${scorecard.version}${scorecard.created ? " (baseline minted)" : ""}`,
  );
} catch (err) {
  app.log.error(
    { err },
    "RBAC catalog reconcile failed — permissions added in this deploy will be invisible until it succeeds (retry via POST /admin/rbac/sync)",
  );
}

await app.listen({ port: config.port, host: config.host });
app.log.info(
  `smart-loan API (${config.nodeEnv}) listening on http://${config.host}:${config.port}`,
);
