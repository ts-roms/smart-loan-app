/**
 * Schema-rename adoption: move an existing single-tenant deployment's
 * data into a `tenant_<slug>` schema so the deployment can flip to
 * `MULTI_TENANT=true` without losing anything.
 *
 * The migration story:
 *
 *   1. Existing single-tenant deploys keep ALL data in `public` — both
 *      the per-tenant domain tables (User, Customer, Loan, …) AND the
 *      platform tables (Tenant, PlatformUser, …, all empty so far).
 *
 *   2. Multi-tenant mode reads/writes per-tenant data from a tenant
 *      schema (`tenant_<slug>`) and platform data from `public`. To
 *      adopt an existing deploy, the per-tenant data has to move out
 *      of `public` and into a new tenant schema.
 *
 *   3. The cleanest move is `ALTER SCHEMA public RENAME TO tenant_<slug>`
 *      followed by `CREATE SCHEMA public` + `prisma migrate deploy`
 *      to seed a fresh empty platform schema. After the rename, every
 *      table (including `_prisma_migrations`) lives under the new
 *      tenant name; the fresh `public` then gets a clean install of
 *      every table (platform tables get used; tenant tables stay empty
 *      dead-weight — the same asymmetry every tenant schema already
 *      has from the other direction).
 *
 *   4. We then insert the Tenant row for the adopted slug (so
 *      `resolveTenant` finds it on first request) and create a
 *      PlatformUser the operator can use to log into the platform
 *      console.
 *
 * ## Why a schema rename, not a per-table move?
 *
 * Two alternatives were considered:
 *
 *   - `ALTER TABLE public.<each> SET SCHEMA tenant_<slug>` for every
 *     tenant table individually. Cleaner intent (we move ONLY tenant
 *     tables, leaving platform tables in public), but the list of
 *     "tenant tables" lives in our heads — every new model added to
 *     Prisma is a potential drift. The rename approach is a single
 *     SQL statement and can't drift.
 *
 *   - `pg_dump` of the tenant tables + `pg_restore` into a fresh
 *     tenant schema. Works, but doubles the disk + RAM footprint
 *     during the migration window, and pg_dump's `--schema` flag is
 *     coarse (you can include or exclude whole schemas; per-table
 *     selection is fiddly).
 *
 * The rename + reinit approach trades a tiny asymmetry (empty tenant
 * tables left over in the fresh public) for atomic SQL and zero risk
 * of missing a model.
 *
 * ## Safety
 *
 *   - Refuses to run if `MULTI_TENANT` is already enabled and the
 *     target tenant slug already exists. We only allow adoption when
 *     it's clearly a first-time migration.
 *   - Refuses to run if `public` has no data — if the operator points
 *     this script at a fresh DB they didn't mean to "adopt" anything.
 *   - Takes a pg_dump backup BEFORE renaming. The dump path is
 *     returned in the result so the operator can verify + archive it.
 *   - The CLI wrapper prints a typed-confirmation prompt (the
 *     operator must type the slug back) so accidental invocation is
 *     unlikely.
 *
 * @see docs/multi-tenant-cutover.md §2.B for the adoption walkthrough
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";

import { migrateTenantSchema, tenantSchemaName } from "./multi-tenant-migrate";

const SLUG_RE = /^[a-z][a-z0-9-]+$/;

export interface AdoptExistingOptions {
  /** Slug for the adopted tenant. Must match the platform slug regex. */
  slug: string;
  /** Display name. Shown in the platform console. */
  name: string;
  /**
   * Email for the bootstrap PlatformUser. The operator gets a temp
   * password printed on stdout (one-time, never persisted). They
   * change it on first login via the platform console.
   */
  platformAdminEmail: string;
  /** Display name for the bootstrap PlatformUser. */
  platformAdminName: string;
  /**
   * Password-hashing function. Injected by the caller so this lib
   * doesn't carry an @loan/auth runtime dependency. The CLI plugs in
   * `hashPassword` from @loan/auth here.
   */
  hashPassword: (plain: string) => Promise<string>;
  /**
   * Base DATABASE_URL. The schema portion is replaced as needed.
   * Defaults to `process.env.DATABASE_URL`.
   */
  baseDatabaseUrl?: string;
  /**
   * Directory to write the pre-rename pg_dump backup to. Defaults to
   * `./backups/<timestamp>-pre-adopt-<slug>.sql`.
   */
  backupDir?: string;
  /**
   * Skip the pg_dump backup. Off by default. Only use in tests or
   * when the operator has an external backup pipeline.
   */
  skipBackup?: boolean;
  /** Forwarded to migration runner. Default 5 min. */
  migrateTimeoutMs?: number;
  /** Logger. Defaults to console.log / .error. */
  logLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface AdoptExistingResult {
  slug: string;
  /** Path to the pre-rename backup, if one was taken. */
  backupPath: string | null;
  /** Generated temp password for the bootstrap PlatformUser. */
  platformAdminTempPassword: string;
  /** PlatformUser id created for the bootstrap admin. */
  platformAdminId: string;
}

/**
 * Atomic-ish adoption flow. The schema rename + create are a single
 * transaction; the prisma migrate deploy + Tenant insert run after
 * commit. If the migrate deploy step fails, the rename has already
 * landed — manual recovery is: copy the dump back into a freshly
 * recreated public schema and try again.
 */
export async function adoptExistingAsTenant(
  controlPrisma: PrismaClient,
  opts: AdoptExistingOptions,
): Promise<AdoptExistingResult> {
  if (!SLUG_RE.test(opts.slug)) {
    throw new Error(
      `Refusing to adopt with unsafe slug ${JSON.stringify(opts.slug)}.`,
    );
  }
  const log =
    opts.logLine ??
    ((line, stream) => {
      if (stream === "stderr") console.error(line);
      else console.log(line);
    });

  const baseUrl = opts.baseDatabaseUrl ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Pass baseDatabaseUrl explicitly or set the env.",
    );
  }

  const tenantSchema = tenantSchemaName(opts.slug);

  // Pre-flight: `public` must have some data (otherwise the operator
  // pointed us at a fresh DB and didn't mean to adopt). We use the
  // Tenant table as a sentinel — its row count is 0 in a clean
  // single-tenant DB, so if it's already populated it means the
  // operator already started using multi-tenant. Also assert that
  // `tenant_<slug>` doesn't already exist.
  await assertAdoptable(controlPrisma, tenantSchema, opts.slug, log);

  // Step 1: pg_dump backup. Critical safety net — the rename is
  // reversible only via this dump. We block the rest of the flow
  // until the backup file exists on disk.
  let backupPath: string | null = null;
  if (!opts.skipBackup) {
    backupPath = await runBackup(baseUrl, opts.slug, opts.backupDir, log);
    log(`✓ backup written to ${backupPath}`, "stdout");
  } else {
    log("⚠ skipping pg_dump backup (skipBackup=true)", "stderr");
  }

  // Step 2: rename public → tenant_<slug> and create a fresh public.
  // Wrapped in a transaction so a failure here can't leave the DB
  // half-renamed. Prisma's `$transaction` over `$executeRawUnsafe` is
  // the simplest way to get that atomicity with identifier-bearing
  // statements.
  log(`renaming public → ${tenantSchema} …`, "stdout");
  await controlPrisma.$transaction([
    controlPrisma.$executeRawUnsafe(
      `ALTER SCHEMA public RENAME TO "${tenantSchema}"`,
    ),
    controlPrisma.$executeRawUnsafe(`CREATE SCHEMA public`),
    // Postgres' default grants on a newly-CREATEd schema are owner-only.
    // We restore the conventional `public` ACL so existing roles can
    // still operate (especially `PUBLIC USAGE`, which Prisma relies on
    // to see its own tables after creation).
    controlPrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO PUBLIC`),
    controlPrisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO PUBLIC`),
  ]);
  log("✓ schema rename committed", "stdout");

  // Step 3: re-run migrations against the freshly empty public schema.
  // This creates all platform tables (Tenant, PlatformUser, …) and
  // also empty tenant tables (dead-weight in public; same asymmetry
  // every tenant schema already has).
  //
  // We can reuse `migrateTenantSchema` here by passing `public` as the
  // "slug" because the function only uses the slug to build the
  // schema name … but the slug regex doesn't accept "public". Inline
  // the spawn instead so the contract stays clean.
  log(
    "running prisma migrate deploy against the new public schema …",
    "stdout",
  );
  await runMigrateAgainstPublic(baseUrl, opts.migrateTimeoutMs, log);
  log("✓ platform schema initialised", "stdout");

  // Step 4: future migrations against the tenant schema need to be
  // applied too. The tenant_<slug> already has all CURRENT migrations
  // (it's a rename of what used to be public). But if this script is
  // run during a release where new migrations exist that the previous
  // single-tenant deploy hadn't applied yet, we want them landed.
  // `prisma migrate deploy` is idempotent so calling it here is safe.
  log(`reconciling migrations against ${tenantSchema} …`, "stdout");
  await migrateTenantSchema(opts.slug, {
    baseDatabaseUrl: baseUrl,
    logLine: log,
    timeoutMs: opts.migrateTimeoutMs,
  });
  log(`✓ ${tenantSchema} migrations up to date`, "stdout");

  // Step 5: insert the Tenant row + bootstrap PlatformUser. Both go
  // into the fresh public schema (where `controlPrisma` lives).
  const platformAdminTempPassword = generateTempPassword();
  const hashedPassword = await opts.hashPassword(platformAdminTempPassword);
  const [tenant, admin] = await controlPrisma.$transaction([
    controlPrisma.tenant.create({
      data: {
        slug: opts.slug,
        name: opts.name,
        status: "ACTIVE",
      },
    }),
    controlPrisma.platformUser.create({
      data: {
        email: opts.platformAdminEmail.toLowerCase(),
        passwordHash: hashedPassword,
        name: opts.platformAdminName,
        role: "PLATFORM_ADMIN",
      },
    }),
  ]);
  log(`✓ Tenant ${tenant.slug} (${tenant.id}) created`, "stdout");
  log(`✓ PlatformUser ${admin.email} created`, "stdout");

  return {
    slug: opts.slug,
    backupPath,
    platformAdminTempPassword,
    platformAdminId: admin.id,
  };
}

async function assertAdoptable(
  controlPrisma: PrismaClient,
  tenantSchema: string,
  slug: string,
  log: (line: string, stream: "stdout" | "stderr") => void,
): Promise<void> {
  // Target schema must not exist.
  const target = await controlPrisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${tenantSchema}
    ) AS exists
  `;
  if (target[0]?.exists) {
    throw new Error(
      `Schema ${tenantSchema} already exists. Adoption is a one-time operation; refusing to overwrite.`,
    );
  }

  // public must have at least one real table — otherwise the operator
  // pointed us at a fresh DB.
  const tableCount = await controlPrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> '_prisma_migrations'
  `;
  const count = Number(tableCount[0]?.count ?? 0);
  if (count === 0) {
    throw new Error(
      "Public schema has no tables. Adoption is meant for an existing single-tenant deploy. If this is a fresh DB, use the normal multi-tenant provisioning flow instead.",
    );
  }

  // Refuse if any Tenant rows already exist — means this DB has
  // already started using multi-tenant, so a rename would clobber
  // the platform's own tenant catalog.
  const tenantCount = await controlPrisma.tenant.count().catch(() => 0);
  if (tenantCount > 0) {
    throw new Error(
      "public.Tenant already has rows. Adoption only runs on a single-tenant deploy that hasn't onboarded any tenants yet. " +
        "If you intended to onboard a new tenant, use the platform console's `Provision Tenant` flow instead.",
    );
  }

  log(`✓ pre-flight checks passed (slug=${slug})`, "stdout");
}

/**
 * `pg_dump` of the current `public` schema. Streams output to a file
 * so memory stays flat even on multi-GB databases. Returns the
 * absolute path on success.
 */
async function runBackup(
  baseUrl: string,
  slug: string,
  backupDir: string | undefined,
  log: (line: string, stream: "stdout" | "stderr") => void,
): Promise<string> {
  const url = new URL(baseUrl);
  // pg_dump reads connection params from env or from a libpq-style
  // URI on the command line. Both work; the URI form is simpler.
  const dumpUri = url.toString();

  const dir = backupDir ?? resolve(process.cwd(), "backups");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${ts}-pre-adopt-${slug}.sql`);

  log(`running pg_dump → ${file} …`, "stdout");

  await new Promise<void>((resolveP, reject) => {
    const cmd = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
    const child = spawn(
      cmd,
      ["--schema=public", "--no-owner", "--no-acl", "--file", file, dumpUri],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (b: Buffer) => {
      const text = b.toString("utf8").trim();
      if (text.length) log(text, "stdout");
    });
    child.stderr.on("data", (b: Buffer) => {
      const text = b.toString("utf8").trim();
      // pg_dump uses stderr for progress messages — forward but don't
      // treat as failure.
      if (text.length) log(text, "stderr");
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `pg_dump failed to start (is it on PATH?): ${(err as Error).message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : reject(new Error(`pg_dump exited with code ${code}`)),
    );
  });

  return file;
}

async function runMigrateAgainstPublic(
  baseUrl: string,
  timeoutMs: number | undefined,
  log: (line: string, stream: "stdout" | "stderr") => void,
): Promise<void> {
  // `migrateTenantSchema` expects a slug — we can't pass "public"
  // because it'd be coerced to `tenant_public`. Inline the spawn here
  // with the un-overridden baseUrl (which by default has no schema
  // param, so Prisma migrates against `public`).
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "..", "..", "prisma", "schema.prisma");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  await new Promise<void>((resolveP, reject) => {
    const child = spawn(
      npxCmd,
      ["prisma", "migrate", "deploy", "--schema", schemaPath],
      {
        env: { ...process.env, DATABASE_URL: baseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `prisma migrate deploy (public) timed out after ${timeoutMs ?? 300000}ms`,
          ),
        );
      },
      timeoutMs ?? 5 * 60 * 1000,
    );

    const forward = (buf: Buffer, stream: "stdout" | "stderr") => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) log(line, stream);
      }
    };
    child.stdout.on("data", (b: Buffer) => forward(b, "stdout"));
    child.stderr.on("data", (b: Buffer) => forward(b, "stderr"));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`prisma migrate failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveP()
        : reject(new Error(`prisma migrate exited with code ${code}`));
    });
  });
}

/**
 * Generate a printable temp password the operator can copy from the
 * CLI output. ~13 chars of base64-url is ~78 bits of entropy — enough
 * for a one-time bootstrap credential. They change it on first login.
 */
function generateTempPassword(): string {
  const bytes = new Uint8Array(10);
  // Use the Web Crypto API which is available in Node 18+ globally.
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
