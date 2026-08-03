import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";

/**
 * Multi-tenant schema provisioning + migration runner.
 *
 * Three operations live here:
 *
 *   - `createTenantSchema`   — `CREATE SCHEMA IF NOT EXISTS tenant_<slug>`
 *   - `migrateTenantSchema`  — runs `prisma migrate deploy` against that
 *                              schema by shelling out with a swapped
 *                              DATABASE_URL
 *   - `dropTenantSchema`     — `DROP SCHEMA tenant_<slug> CASCADE`,
 *                              only ever called from explicit ops
 *                              tooling (NOT auto-fired on archive)
 *
 * ## Why shell out for migrate
 *
 * Prisma has no stable programmatic API for `migrate deploy`. The
 * official recommendation is to use the CLI. We invoke it via `npx`
 * (works in both dev and the Docker production image; both have
 * Prisma in node_modules). Stdout is forwarded to the caller's
 * logger so operators can watch migrations progress against a
 * specific tenant.
 *
 * ## Security: slug validation is the boundary
 *
 * Prisma's parameterized queries don't support identifier parameters
 * — schema names go into the SQL as raw text. So a malicious slug
 * like `acme"; DROP TABLE "User` would be catastrophic if we ever
 * let it through. Both `createTenantSchema` and `dropTenantSchema`
 * call `assertSafeSlug` first; if the slug fails the regex, the
 * function throws BEFORE any SQL runs.
 *
 * The slug also has to match the platform-side schema (apps/api/
 * src/features/platform/schemas.ts → `tenantSlugSchema`). Keep
 * these in sync; the regex below is the source of truth for what
 * counts as a SQL-safe tenant slug.
 *
 * @see docs/multi-tenant-implementation.md §5
 */

const SLUG_RE = /^[a-z][a-z0-9-]+$/;

function assertSafeSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Refusing to operate on unsafe tenant slug ${JSON.stringify(slug)}. ` +
        `Slugs must match /^[a-z][a-z0-9-]+$/ (lowercase alphanumeric + dashes, starting with a letter).`,
    );
  }
}

/** Postgres schema name for a tenant slug. */
export function tenantSchemaName(slug: string): string {
  assertSafeSlug(slug);
  return `tenant_${slug}`;
}

/**
 * Build the DATABASE_URL for a given tenant. Adds `?schema=tenant_<slug>`
 * to the base URL (replacing any pre-existing schema param). Also tightens
 * the connection limit by default — multi-tenant deployments care about
 * total connection count, and short-lived migration runs don't need a
 * pool.
 */
export function tenantDatabaseUrl(
  baseDatabaseUrl: string,
  slug: string,
  opts: { connectionLimit?: number } = {},
): string {
  const url = new URL(baseDatabaseUrl);
  url.searchParams.set("schema", tenantSchemaName(slug));
  if (opts.connectionLimit !== undefined) {
    url.searchParams.set("connection_limit", String(opts.connectionLimit));
  }
  return url.toString();
}

/**
 * `CREATE SCHEMA IF NOT EXISTS "tenant_<slug>"` using the control-plane
 * client. Idempotent; subsequent calls are no-ops.
 *
 * Use the public-schema PrismaClient (i.e. `app.prisma`) — this query
 * lives outside any tenant's schema by design.
 */
export async function createTenantSchema(
  slug: string,
  controlPrisma: PrismaClient,
): Promise<void> {
  const schema = tenantSchemaName(slug);
  // $executeRawUnsafe is fine here because we've already validated
  // the slug; Prisma's parameterized queries don't support
  // identifiers. Double quotes around the identifier are required
  // — Postgres folds unquoted identifiers to lowercase, which would
  // already be fine, but keeping the quotes makes the contract
  // explicit for future schema names that might mix case.
  await controlPrisma.$executeRawUnsafe(
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
  );
}

/**
 * `DROP SCHEMA "tenant_<slug>" CASCADE`. Destructive — every table,
 * every row, every file reference inside the schema is gone after
 * this returns. Not called automatically by archival; vendor staff
 * must run it explicitly (CLI or platform UI button with a typed
 * confirmation).
 */
export async function dropTenantSchema(
  slug: string,
  controlPrisma: PrismaClient,
): Promise<void> {
  const schema = tenantSchemaName(slug);
  await controlPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
  );
}

export interface MigrateOptions {
  /**
   * Base DATABASE_URL pointing at the Postgres instance. The schema
   * portion is replaced per-tenant.
   */
  baseDatabaseUrl?: string;
  /**
   * Where to send stdout/stderr lines from the prisma CLI. Defaults
   * to `console.log` / `console.error`. The platform service plugs
   * its Fastify logger in.
   */
  logLine?: (line: string, stream: "stdout" | "stderr") => void;
  /**
   * Timeout in ms. Migration runs are usually <30s but can be slow
   * on a fresh tenant with all ~50 migrations. Default 5 minutes.
   */
  timeoutMs?: number;
}

/**
 * Run `prisma migrate deploy` against `tenant_<slug>`. Resolves on
 * success, rejects with the captured stderr on failure.
 *
 * The schema must exist first (call `createTenantSchema`). If it
 * doesn't, Prisma will create the migrations table in `public`
 * because that's the default, and we don't want that — assert
 * schema existence with `assertTenantSchemaExists` if you're
 * paranoid.
 *
 * Implementation notes:
 *
 *   - We spawn `npx prisma migrate deploy --schema=<path-to-schema>`.
 *     `npx` resolves from the local node_modules; same binary the
 *     dev workflow uses.
 *   - The schema.prisma path is computed relative to this file so
 *     it works from the workspace root, from the api process, and
 *     from the migrate-tenants CLI.
 *   - We DON'T use execSync — that blocks the event loop, which
 *     matters when the API kicks off provisioning in the background.
 *     spawn gives us streamed output we can forward to logs.
 */
export function migrateTenantSchema(
  slug: string,
  opts: MigrateOptions = {},
): Promise<void> {
  assertSafeSlug(slug);

  const baseUrl = opts.baseDatabaseUrl ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    return Promise.reject(
      new Error(
        "DATABASE_URL is not set. Pass baseDatabaseUrl explicitly or set the env.",
      ),
    );
  }
  const tenantUrl = tenantDatabaseUrl(baseUrl, slug, { connectionLimit: 2 });

  // Resolve the schema.prisma path relative to this source file.
  // libs/db/src/lib/multi-tenant-migrate.ts → libs/db/prisma/schema.prisma
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, "..", "..");
  const schemaPath = resolve(packageRoot, "prisma", "schema.prisma");

  const logLine =
    opts.logLine ??
    ((line, stream) => {
      if (stream === "stderr") console.error(line);
      else console.log(line);
    });

  return new Promise<void>((resolveP, reject) => {
    // npx is portable across pnpm / npm / yarn workflows. The
    // alternative (`pnpm exec prisma ...`) would couple the runner
    // to pnpm being on PATH inside the runtime image.
    //
    // Windows needs a shell here. Since the fix for CVE-2024-27980
    // (Node 18.20.2 / 20.12.2) spawn refuses to run a .cmd or .bat
    // directly — it throws EINVAL — and `npx` on Windows is `npx.cmd`.
    // Naming the .cmd explicitly used to be the workaround; it isn't
    // one any more, and without a shell tenant provisioning fails on
    // every Windows host.
    //
    // Under a shell, pass the plain name and let PATHEXT resolve it:
    // spawning "npx.cmd" through cmd.exe re-quotes badly enough that
    // the arguments arrive mangled. Node quotes the args array itself
    // in shell mode, so paths with spaces need no help from us.
    const isWindows = process.platform === "win32";

    const child = spawn(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", schemaPath],
      {
        env: { ...process.env, DATABASE_URL: tenantUrl },
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
        /**
         * Run from @loan/db, which is the only package that depends on
         * prisma — under pnpm's isolated layout its bin exists at
         * libs/db/node_modules/.bin and nowhere else. The caller is
         * whoever triggered provisioning (the API, cwd apps/api), and
         * `npx prisma` resolved from there finds nothing and reports
         * "prisma is not recognized". Nothing about that is
         * Windows-specific.
         */
        cwd: packageRoot,
      },
    );

    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Migration for tenant ${slug} timed out after ${opts.timeoutMs ?? 300000}ms`,
          ),
        );
      },
      opts.timeoutMs ?? 5 * 60 * 1000,
    );

    const forward = (buf: Buffer, stream: "stdout" | "stderr") => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) logLine(line, stream);
      }
    };
    child.stdout.on("data", (b: Buffer) => forward(b, "stdout"));
    child.stderr.on("data", (b: Buffer) => forward(b, "stderr"));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn prisma migrate for tenant ${slug}: ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveP();
      } else {
        reject(
          new Error(
            `prisma migrate deploy exited with code ${code} for tenant ${slug}`,
          ),
        );
      }
    });
  });
}

/**
 * Sanity check used by the platform service before a "retry" — does
 * the schema exist? Returns true / false; doesn't create.
 */
export async function tenantSchemaExists(
  slug: string,
  controlPrisma: PrismaClient,
): Promise<boolean> {
  const schema = tenantSchemaName(slug);
  const rows = await controlPrisma.$queryRaw<Array<{ schema_name: string }>>`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = ${schema}
    LIMIT 1
  `;
  return rows.length > 0;
}
