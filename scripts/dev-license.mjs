#!/usr/bin/env node
/**
 * DEV-ONLY: mint a self-signed license and activate it directly in the
 * local database, so gated (PROFESSIONAL / ENTERPRISE) features work in
 * `pnpm run dev` without standing up the platform console.
 *
 * It signs with the local dev keypair in libs/licensing/keys/ (created
 * by `pnpm --filter @loan/licensing keygen`), verifies the token exactly
 * as the API would, then upserts a row into the License table — the same
 * write LicensingService.activate() performs, minus the audit entry and
 * with activatedById left null (the column is nullable).
 *
 * This is NOT how production licensing works — real tenants paste a
 * vendor-issued token into Settings → License. This script only exists
 * to unblock local development. The keys it uses are gitignored and
 * unique to this checkout; a token minted here verifies nowhere else.
 *
 * Usage (from repo root):
 *   pnpm dev:license                       # ENTERPRISE, all features, ~10y
 *   pnpm dev:license -- --tier PROFESSIONAL
 *   pnpm dev:license -- --tenant "My Co-op" --expires 2031-01-01
 *   pnpm dev:license -- --status           # show current license status
 *   pnpm dev:license -- --deactivate       # revoke the active dev license
 *
 * Requires the dev DB to be up (docker compose -f docker-compose.dev.yml
 * up -d) and DATABASE_URL reachable (read from the root .env if not set
 * in the environment).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPrismaClient } from "@loan/db";
import {
  defaultFeaturesForTier,
  LICENSE_FORMAT_VERSION,
  LICENSE_TIERS,
  loadPublicKeyPem,
  signLicense,
  TIER_SEATS,
  verifyLicense,
} from "@loan/licensing";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KEYS_DIR = resolve(ROOT, "libs", "licensing", "keys");
const PRIV = resolve(KEYS_DIR, "private.pem");
const PUB = resolve(KEYS_DIR, "public.pem");

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ─── args ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// ─── DATABASE_URL: env first, else parse root .env ──────────────────────
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}
const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) {
  die("DATABASE_URL not set and not found in .env. Is the dev DB configured?");
}

// Set the env var too, not just the constructor override: with this
// Prisma client version the `datasources` override is unreliable and the
// schema's `env("DATABASE_URL")` wins, so a parsed-from-.env value must
// land in the environment to actually take effect.
process.env.DATABASE_URL = databaseUrl;
const prisma = createPrismaClient(databaseUrl);

// ─── --status (mirrors LicensingService.loadCurrent) ────────────────────
if (args.status) {
  const pub = loadPublicKeyPem();
  if (!pub) {
    console.error(
      "status: NO_KEY — LICENSE_PUBLIC_KEY_PEM/PATH not set in this env.",
    );
    await prisma.$disconnect();
    process.exit(0);
  }
  const row = await prisma.license.findFirst({
    where: { revokedAt: null },
    orderBy: { activatedAt: "desc" },
  });
  if (!row) {
    console.error("status: NONE — no active license row.");
    await prisma.$disconnect();
    process.exit(0);
  }
  const v = verifyLicense(row.token, pub);
  if (v.ok) {
    console.error(
      `status: ACTIVE — ${v.payload.tier} for "${v.payload.tenant}", ${v.payload.features.length} features, expires ${new Date(v.payload.exp).toISOString().slice(0, 10)}.`,
    );
  } else {
    console.error(`status: ${v.kind} — ${v.message}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

// ─── --deactivate ───────────────────────────────────────────────────────
if (args.deactivate) {
  const current = await prisma.license.findFirst({
    where: { revokedAt: null },
    orderBy: { activatedAt: "desc" },
  });
  if (!current) {
    console.error("No active license to deactivate.");
  } else {
    await prisma.license.update({
      where: { id: current.id },
      data: { revokedAt: new Date() },
    });
    console.error(`✔ Deactivated license ${current.jti} (${current.tier}).`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

// ─── keys ───────────────────────────────────────────────────────────────
if (!existsSync(PRIV) || !existsSync(PUB)) {
  die(
    "Dev keypair missing. Run: pnpm --filter @loan/licensing keygen  (creates libs/licensing/keys/).",
  );
}
const privatePem = readFileSync(PRIV, "utf8");
const publicPem = readFileSync(PUB, "utf8");

// ─── mint ───────────────────────────────────────────────────────────────
const tier = args.tier ? String(args.tier) : "ENTERPRISE";
if (!LICENSE_TIERS.includes(tier)) {
  die(`Unknown tier ${tier}. One of: ${LICENSE_TIERS.join(", ")}`);
}
const tenant = args.tenant ? String(args.tenant) : "Dev Co-op";
// Default expiry ~10 years out. A fixed far-future date keeps the dev
// license stable across runs without needing the current clock.
const expires = args.expires ? String(args.expires) : "2035-12-31";
const expMs = Date.parse(expires);
if (Number.isNaN(expMs)) die(`--expires must be a parseable date: ${expires}`);

const features = args.features
  ? String(args.features).split(",").map((s) => s.trim()).filter(Boolean)
  : defaultFeaturesForTier(tier);

const payload = {
  v: LICENSE_FORMAT_VERSION,
  jti: randomUUID(),
  tenant,
  tier,
  features,
  iat: Date.now(),
  exp: expMs,
  seats: TIER_SEATS[tier],
  notes: "DEV license — minted by scripts/dev-license.mjs",
};

const token = signLicense(payload, privatePem);

// ─── verify (exactly as the API will) ───────────────────────────────────
const verified = verifyLicense(token, publicPem);
if (!verified.ok) {
  die(`Self-verification failed (${verified.kind}): ${verified.message}`);
}

// ─── activate (upsert into the License table) ───────────────────────────
const row = await prisma.license.upsert({
  where: { jti: payload.jti },
  create: {
    token,
    jti: payload.jti,
    tenantName: payload.tenant,
    tier: payload.tier,
    payload,
    issuedAt: new Date(payload.iat),
    expiresAt: new Date(payload.exp),
    seats: payload.seats,
    notes: payload.notes,
    activatedAt: new Date(),
    activatedById: null,
  },
  update: {
    token,
    activatedAt: new Date(),
    revokedAt: null,
    revokedById: null,
  },
});

await prisma.$disconnect();

console.error("✔ Dev license activated");
console.error(`  tenant    ${payload.tenant}`);
console.error(`  tier      ${payload.tier}`);
console.error(`  features  ${features.length}`);
console.error(`  expires   ${new Date(payload.exp).toISOString().slice(0, 10)}`);
console.error(`  row id    ${row.id}`);
console.error("");
console.error(
  "Ensure LICENSE_PUBLIC_KEY_PEM (or _PATH) is set in .env so the API can verify it, then restart `pnpm run dev`.",
);
