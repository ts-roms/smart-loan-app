/**
 * Signed access to stored uploads.
 *
 * `/uploads/` is served statically, so until now the unguessable UUID
 * filename was the only thing protecting a stored KYC document from
 * anyone who came across the URL. UUIDs don't leak by enumeration, but
 * URLs leak plenty of other ways — proxy and CDN logs, referrer
 * headers, browser history sync, a screenshot pasted into a chat.
 *
 * A protected file now needs `?exp=<unix-ms>&sig=<hmac>` appended, and
 * the client mints that through an authenticated endpoint.
 *
 * ## What this does and does not buy
 *
 * It closes the anonymous hole: a leaked URL is useless to the public
 * internet once it expires, and useless immediately without a
 * signature. It does NOT scope a document to the staff member who
 * should see it — any authenticated caller can sign any path. That is
 * the same reach an authenticated caller already had, so this is
 * strictly an improvement rather than a complete answer; a real
 * ownership model would have to live in the sign endpoint, and there
 * is no per-officer assignment in the schema to check against today
 * (the same gap documents.routes.ts calls out).
 *
 * ## Why HMAC and not a database row
 *
 * A signature is verified with the secret alone. The static handler
 * stays free of a per-request database round-trip, which matters when
 * a review screen renders a dozen thumbnails at once.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../../config";

/**
 * Subdirectories whose contents require a signature.
 *
 * `branding` is deliberately absent: the company logo renders in the
 * shell and on the login screen, before anyone has a token to sign
 * with. It's also the one upload class that carries no personal data.
 *
 * `misc` IS protected. It's the catch-all, so its contents are exactly
 * what nobody classified — the wrong thing to default to public.
 */
const PROTECTED_SUBDIRS = new Set([
  "kyc",
  "selfies",
  "collateral",
  "signatures",
  "misc",
]);

/** How long a minted URL stays valid. */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Does this `/uploads/...` path need a signature?
 *
 * Anything that isn't recognizably `/uploads/<known-subdir>/...` is
 * treated as protected. An unknown shape is either a bug or an attempt
 * to slip past the check, and neither deserves the public branch.
 */
export function isProtectedUploadPath(pathname: string): boolean {
  const rest = pathname.startsWith("/uploads/")
    ? pathname.slice("/uploads/".length)
    : pathname.replace(/^\/+/, "");
  const subdir = rest.split("/")[0] ?? "";
  return PROTECTED_SUBDIRS.has(subdir) || !isKnownPublicSubdir(subdir);
}

function isKnownPublicSubdir(subdir: string): boolean {
  return subdir === "branding";
}

/**
 * The signed payload is the path plus the expiry. Both must be in it:
 * signing the path alone would mint a permanent credential, and
 * signing the expiry alone would let one file's signature open another.
 */
function computeSignature(pathname: string, expiresAt: number): string {
  return createHmac("sha256", config.jwtSecret)
    .update(`${pathname}|${expiresAt}`)
    .digest("hex");
}

export interface SignedUpload {
  /** Path with `exp` and `sig` appended, ready to use as a src. */
  url: string;
  expiresAt: number;
}

/** Mint a time-limited URL for a stored upload. */
export function signUploadPath(
  pathname: string,
  ttlMs: number = SIGNED_URL_TTL_MS,
  now: number = Date.now(),
): SignedUpload {
  const expiresAt = now + ttlMs;
  const sig = computeSignature(pathname, expiresAt);
  return {
    url: `${pathname}?exp=${expiresAt}&sig=${sig}`,
    expiresAt,
  };
}

export type VerifyResult = "ok" | "missing" | "expired" | "invalid";

/** Verify a signature. Distinguishes the failure modes for logging. */
export function verifyUploadSignature(
  pathname: string,
  exp: string | undefined,
  sig: string | undefined,
  now: number = Date.now(),
): VerifyResult {
  if (!exp || !sig) return "missing";
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt)) return "invalid";
  // Expiry is checked BEFORE the compare so an expired-but-valid
  // signature reports as expired — the client refreshes on that, and
  // would otherwise see the same 403 as a forged one.
  if (expiresAt <= now) return "expired";

  const expected = computeSignature(pathname, expiresAt);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself an
  // observable difference — but a wrong length is already a wrong
  // signature, so there's nothing to leak by returning early.
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "ok" : "invalid";
}
