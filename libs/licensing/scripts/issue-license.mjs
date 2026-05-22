#!/usr/bin/env node
/**
 * Platform-side: produce a signed license token from a CLI. Pipes the
 * token to stdout so it can be `>` redirected into a file or piped
 * into `pbcopy` / `clip`.
 *
 * Usage:
 *   pnpm --filter @loan/licensing issue -- \
 *     --tenant "Mt Banahaw MPC" \
 *     --tier ENTERPRISE \
 *     --expires 2027-05-22 \
 *     [--nbf 2026-06-01] \
 *     [--seats 25] \
 *     [--features intel.ai_assistant,intel.face_match] \
 *     [--notes "Initial year-1 license"]
 *
 *   # Or pipe straight to clipboard on macOS:
 *   pnpm --filter @loan/licensing issue -- --tenant Foo --tier BASIC \
 *     --expires 2027-01-01 | pbcopy
 *
 * If --features is omitted, the tier's default catalog is used (see
 * libs/licensing/src/features.ts). If --seats is omitted, the tier's
 * default seat cap is used.
 *
 * Resolution order for the signing key:
 *   1. LICENSE_PRIVATE_KEY_PEM env
 *   2. LICENSE_PRIVATE_KEY_PATH env
 *   3. libs/licensing/keys/private.pem (default, created by keygen)
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import from src directly since the lib has no build step.
import { defaultFeaturesForTier, TIER_SEATS } from "../src/features.ts";
import { loadPrivateKeyPem } from "../src/keys.ts";
import { signLicense } from "../src/sign.ts";
import { LICENSE_FORMAT_VERSION, LICENSE_TIERS } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRIV = resolve(HERE, "..", "keys", "private.pem");

// ─── arg parsing ───────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ─── validation ───────────────────────────────────────────────────────
if (!args.tenant) die("--tenant <name> is required");
if (!args.tier) die("--tier <BASIC|PROFESSIONAL|ENTERPRISE> is required");
if (!LICENSE_TIERS.includes(args.tier)) {
  die(`Unknown tier ${args.tier}. Must be one of: ${LICENSE_TIERS.join(", ")}`);
}
if (!args.expires) die("--expires <YYYY-MM-DD> is required");

const expMs = Date.parse(args.expires);
if (Number.isNaN(expMs)) die(`--expires must be a parseable date, got ${args.expires}`);
if (expMs <= Date.now()) die(`--expires must be in the future, got ${args.expires}`);

let nbfMs;
if (args.nbf !== undefined) {
  nbfMs = Date.parse(args.nbf);
  if (Number.isNaN(nbfMs)) die(`--nbf must be a parseable date, got ${args.nbf}`);
}

let features;
if (args.features) {
  features = String(args.features)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
} else {
  features = defaultFeaturesForTier(args.tier);
}

const seats = args.seats !== undefined ? Number(args.seats) : TIER_SEATS[args.tier];
if (!Number.isInteger(seats) || seats < 0) {
  die(`--seats must be a non-negative integer, got ${args.seats}`);
}

// ─── key resolution ────────────────────────────────────────────────────
let privatePem = loadPrivateKeyPem();
if (!privatePem) {
  if (existsSync(DEFAULT_PRIV)) {
    privatePem = (await import("node:fs")).readFileSync(DEFAULT_PRIV, "utf8");
  } else {
    die(
      "No private key found. Set LICENSE_PRIVATE_KEY_PEM/PATH, or run `pnpm --filter @loan/licensing keygen` to generate libs/licensing/keys/private.pem.",
    );
  }
}

// ─── sign ──────────────────────────────────────────────────────────────
const payload = {
  v: LICENSE_FORMAT_VERSION,
  jti: randomUUID(),
  tenant: String(args.tenant),
  tier: args.tier,
  features,
  iat: Date.now(),
  nbf: nbfMs,
  exp: expMs,
  seats,
  notes: args.notes ? String(args.notes) : undefined,
};

const token = signLicense(payload, privatePem);

// Diagnostics go to stderr so the token (stdout) can be piped cleanly.
console.error("─── License issued ───────────────────────────────────");
console.error(`  tenant   ${payload.tenant}`);
console.error(`  tier     ${payload.tier}`);
console.error(`  jti      ${payload.jti}`);
console.error(`  iat      ${new Date(payload.iat).toISOString()}`);
if (payload.nbf) console.error(`  nbf      ${new Date(payload.nbf).toISOString()}`);
console.error(`  exp      ${new Date(payload.exp).toISOString()}`);
console.error(`  seats    ${payload.seats === 0 ? "unlimited" : payload.seats}`);
console.error(`  features ${payload.features.length}`);
if (payload.notes) console.error(`  notes    ${payload.notes}`);
console.error("──────────────────────────────────────────────────────");
console.error("");

process.stdout.write(token + "\n");
