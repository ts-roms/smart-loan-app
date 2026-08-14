/**
 * The one storage backend the API uses, and the mapping between a
 * stored URL and a storage key.
 *
 * ## Keys are the URL minus the prefix
 *
 * A stored file has always been addressed as `/uploads/<subdir>/<name>`,
 * and that string is what sits on `KycDocument.documentUrl`,
 * `Loan.borrowerSignatureUrl`, `SystemConfig.companyLogoUrl` and a dozen
 * other columns. The storage key is simply that path with `/uploads/`
 * removed — `kyc/6f1c….png`.
 *
 * That correspondence is the reason this change needs no data
 * migration, which the roadmap had flagged as the high-risk part of
 * item 3.1. Every existing row keeps working against either backend,
 * and a bucket populated by copying the uploads tree lines up key for
 * key with what the database already says.
 */

import { createStorage, isSafeKey, type StorageBackend } from "@loan/storage";

import { config, storageConfig } from "../../config";

export const UPLOADS_URL_PREFIX = "/uploads/";

let cached: StorageBackend | undefined;

/**
 * Process-wide backend, built on first use.
 *
 * Lazy rather than module-scope so that `config` has finished reading
 * the environment first — the existing tests set `UPLOADS_DIR` before
 * their first dynamic import and rely on that ordering.
 */
export function uploadStorage(log?: {
  warn: (obj: object, msg: string) => void;
}): StorageBackend {
  cached ??= createStorage(storageConfig(), log);
  return cached;
}

/** Test seam: forget the memoized backend so the next call rebuilds it. */
export function resetUploadStorage(): void {
  cached = undefined;
}

/** `kyc/a.png` → `/uploads/kyc/a.png`. */
export function urlForKey(key: string): string {
  return `${UPLOADS_URL_PREFIX}${key}`;
}

/**
 * `/uploads/kyc/a.png` → `kyc/a.png`, or null when the URL is not a
 * stored upload or is not a shape we are willing to turn into a key.
 *
 * Returns null rather than throwing because every caller treats an
 * unreadable reference as "no file" — a signature that won't load
 * falls back to a blank signature line, and a static request that
 * doesn't map to a key is a 404. Neither wants an exception.
 */
export function keyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith(UPLOADS_URL_PREFIX)) return null;
  const key = path.slice(UPLOADS_URL_PREFIX.length);
  // `isSafeKey` is the same validator the backends apply, so a
  // traversal-shaped URL is refused here rather than deeper in.
  return isSafeKey(key) ? key : null;
}

/** Human-readable backend summary for the boot log. */
export function describeStorage(): string {
  const storage = uploadStorage();
  return storage.driver === "LOCAL"
    ? `local disk (${storage.localRoot})`
    : `S3 (bucket ${config.s3Bucket}${config.s3Endpoint ? ` @ ${config.s3Endpoint}` : ""})`;
}
