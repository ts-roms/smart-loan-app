#!/usr/bin/env node
/**
 * bootstrap-admin — create the first ADMIN user on a fresh SINGLE-TENANT
 * deployment, plus the reference data the API expects to exist.
 *
 * Usage:
 *   pnpm --filter @loan/db bootstrap-admin --email admin@yourcoop.org
 *
 * Optional:
 *   --name "Jane Dela Cruz"   display name (default "Cooperative Admin")
 *   --url  postgres://…       target database; defaults to DATABASE_URL.
 *                             On Railway pass DATABASE_PUBLIC_URL — the
 *                             internal *.railway.internal address only
 *                             resolves from inside the project network.
 *
 * Why this exists rather than `pnpm db:seed`
 *
 *   prisma/seed.ts is the DEVELOPMENT seed. It creates four accounts —
 *   admin/officer/accountant/collector — all with the password
 *   `P@ssw0rd123`, which is committed to this repository and therefore
 *   public. That is fine for a local database on localhost and
 *   catastrophic on a deployment with a public URL: it is an ADMIN
 *   account whose credentials anyone reading the repo already has.
 *
 *   This script instead delegates to seedTenant(), the same helper the
 *   platform console uses when it provisions a cooperative. It creates
 *   exactly one ADMIN, with a high-entropy generated password, and
 *   seeds the permission catalog, roles, chart of accounts, loan
 *   products and decision rules identically.
 *
 * Idempotent: seedTenant() skips the user when the email already
 * exists, and every reference-data seed is an upsert. Re-running is
 * safe, but it will NOT rotate an existing user's password — the
 * password is issued once, on creation. If it was lost, delete the user
 * and re-run, or change it from the app.
 *
 * The password is written to a FILE, not printed. Terminal scrollback,
 * shell history and CI logs all outlive the moment you need it.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedTenant } from "../src/lib/seed-tenant";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const email = flag("email");
const name = flag("name");
/*
 * DATABASE_PUBLIC_URL wins over DATABASE_URL when both are present.
 *
 * That looks backwards until you see how this gets run against a
 * deployment:
 *
 *   railway run --service Postgres -- pnpm --filter @loan/db \
 *     exec tsx scripts/bootstrap-admin.ts --email admin@yourcoop.org
 *
 * `railway run` injects the service's variables into a LOCAL process,
 * so DATABASE_URL arrives holding the internal `*.railway.internal`
 * address — which resolves only from inside the project network and
 * fails here with ENOTFOUND. DATABASE_PUBLIC_URL is the TCP proxy and
 * is the only one that works from an operator's machine.
 *
 * Preferring it also means the URL never has to be pasted onto a
 * command line, where it would land in shell history.
 *
 * Locally there is no DATABASE_PUBLIC_URL, so DATABASE_URL is used and
 * nothing changes. `--url` beats both.
 *
 * Empty is treated as absent, not as a value. Railway DEFINES
 * DATABASE_PUBLIC_URL on a Postgres service whether or not a TCP proxy
 * is enabled, leaving it as an empty string when there is none — and
 * `??` only falls through on null/undefined, so a plain
 * `?? process.env.DATABASE_URL` would latch onto "" and report "no
 * database URL" on a box where DATABASE_URL was set perfectly well.
 */
const firstSet = (...vals: (string | undefined)[]) =>
  vals.find((v) => v !== undefined && v.trim() !== "");

const url = firstSet(
  flag("url"),
  process.env.DATABASE_PUBLIC_URL,
  process.env.DATABASE_URL,
);

if (!email) {
  console.error(
    "Missing --email.\n\n" +
      "  pnpm --filter @loan/db bootstrap-admin --email admin@yourcoop.org\n",
  );
  process.exit(1);
}
if (!url) {
  console.error(
    "No database URL. Pass --url or set DATABASE_URL.\n\n" +
      "  On Railway, use the PUBLIC url — the internal one does not\n" +
      "  resolve from outside the project:\n" +
      "    railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL\n",
  );
  process.exit(1);
}

/*
 * Guard against the multi-tenant case. With MULTI_TENANT=true the
 * User rows live in `tenant_<slug>`, not `public`, and an admin
 * created here would sit in a schema nothing reads — the login would
 * keep failing with no indication why. Provisioning through the
 * platform console is the correct path there.
 */
if ((process.env.MULTI_TENANT ?? "").toLowerCase() === "true") {
  console.error(
    "MULTI_TENANT=true — this script targets the public schema and the\n" +
      "user would be invisible to the app. Provision the cooperative from\n" +
      "the platform console instead; it calls the same seedTenant() helper\n" +
      "against the right schema and surfaces the password once.\n",
  );
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const result = await seedTenant({
    prisma,
    adminEmail: email!,
    adminName: name,
  });

  const s = result.summary;
  console.log("Reference data (created / already present):");
  console.log(`  permissions      ${s.permissionsCreated}`);
  console.log(`  roles            ${s.rolesCreated}`);
  console.log(`  accounts         ${s.accountsCreated}`);
  console.log(`  loan products    ${s.productsCreated}`);
  console.log(`  decision rules   ${s.decisionRulesCreated}`);
  console.log();

  if (!result.generatedPassword) {
    console.log(
      `A user already exists at ${email} — left untouched, no password\n` +
        "issued. Reference data above is up to date.",
    );
    return;
  }

  // Written, not printed: see the note at the top of the file.
  const out = resolve(process.cwd(), "admin-credentials.txt");
  writeFileSync(
    out,
    `SmartLoan bootstrap admin\n` +
      `email:    ${email}\n` +
      `password: ${result.generatedPassword}\n\n` +
      `Sign in, change this password, then delete this file.\n`,
    { mode: 0o600 },
  );
  console.log(`Created ADMIN ${email}.`);
  console.log(`Password written to ${out} (mode 600).`);
  console.log("Sign in, change it, then delete that file.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
