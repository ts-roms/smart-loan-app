import { readFileSync } from "node:fs";

/**
 * Resolve the platform's Ed25519 public key. Resolution order:
 *
 *   1. `LICENSE_PUBLIC_KEY_PEM` env — full PEM, with `\n` escape sequences
 *      expanded. Convenient for managed-secret deploys.
 *   2. `LICENSE_PUBLIC_KEY_PATH` env — filesystem path to a PEM file.
 *   3. Bundled fallback at `libs/licensing/keys/public.pem`, IF present.
 *      A clean checkout has no bundled key (it's gitignored) — that's
 *      intentional, deployers must explicitly provide one. The boot
 *      hook surfaces a clear error when none of the above resolves.
 *
 * Returns `null` when nothing is configured. The caller decides how
 * loud to be about that (the API boot hook logs a warning + runs in
 * "unlicensed grace mode").
 */
export function loadPublicKeyPem(): string | null {
  const inline = process.env.LICENSE_PUBLIC_KEY_PEM;
  if (inline && inline.trim().length > 0) {
    // Allow `\n` escape sequences in env so the PEM can ride in a
    // single-line .env value.
    return inline.replace(/\\n/g, "\n");
  }
  const path = process.env.LICENSE_PUBLIC_KEY_PATH;
  if (path && path.trim().length > 0) {
    return readFileSync(path, "utf8");
  }
  // No env override — caller falls back to bundled key (or null).
  return null;
}

/**
 * Resolve the platform's Ed25519 private key. ONLY used by the
 * platform-side `issue-license` CLI. The tenant-side API never loads
 * a private key — the whole point of asymmetric signing is that the
 * private half stays with the platform.
 *
 *   1. `LICENSE_PRIVATE_KEY_PEM` env
 *   2. `LICENSE_PRIVATE_KEY_PATH` env
 *
 * Returns null when nothing is configured; the CLI prints a clear
 * "run pnpm --filter @loan/licensing keygen first" error in that case.
 */
export function loadPrivateKeyPem(): string | null {
  const inline = process.env.LICENSE_PRIVATE_KEY_PEM;
  if (inline && inline.trim().length > 0) {
    return inline.replace(/\\n/g, "\n");
  }
  const path = process.env.LICENSE_PRIVATE_KEY_PATH;
  if (path && path.trim().length > 0) {
    return readFileSync(path, "utf8");
  }
  return null;
}
