#!/usr/bin/env node
/**
 * One-time platform key generation. Produces an Ed25519 keypair and
 * writes both halves to `libs/licensing/keys/`:
 *
 *   - `private.pem` — STAYS WITH THE PLATFORM. Used by issue-license.mjs.
 *                     gitignored. Never ship to a tenant.
 *   - `public.pem`  — distributed with the API build. Tenants verify
 *                     license tokens against this. Safe to commit.
 *
 * Refuses to overwrite existing keys (running it again on a working
 * deploy would invalidate every license already in the wild). Pass
 * `--force` if you intentionally want to rotate (and remember to
 * re-issue every active license afterwards).
 *
 * Usage:
 *   pnpm --filter @loan/licensing keygen
 *   pnpm --filter @loan/licensing keygen -- --force   # rotate
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", "keys");
const PRIV = resolve(KEYS_DIR, "private.pem");
const PUB = resolve(KEYS_DIR, "public.pem");

const FORCE = process.argv.includes("--force");

if (!FORCE && (existsSync(PRIV) || existsSync(PUB))) {
  console.error(
    "✖ Keys already exist at libs/licensing/keys/. Pass --force to overwrite (this will invalidate every license already issued).",
  );
  process.exit(1);
}

mkdirSync(KEYS_DIR, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicPem = publicKey.export({ format: "pem", type: "spki" });

writeFileSync(PRIV, privatePem, { mode: 0o600 });
writeFileSync(PUB, publicPem, { mode: 0o644 });

console.log("✔ Generated Ed25519 keypair");
console.log(`  private  ${PRIV}`);
console.log(`  public   ${PUB}`);
console.log("");
console.log("Next steps:");
console.log("  1. Keep private.pem on the platform machine only.");
console.log("     It's gitignored — never commit it.");
console.log("  2. Bake public.pem into the tenant API deploy.");
console.log("     Set LICENSE_PUBLIC_KEY_PATH=/path/to/public.pem in the");
console.log("     tenant's .env, OR paste its contents into");
console.log("     LICENSE_PUBLIC_KEY_PEM (escape newlines as \\n).");
console.log("  3. Issue your first license: pnpm --filter @loan/licensing issue");
