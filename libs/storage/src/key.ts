/**
 * Storage keys, and the traversal check that makes them safe.
 *
 * A key looks like `kyc/6f1c2b8a-….png` — a POSIX-ish relative path with
 * no leading slash. That shape is not an accident: it is exactly the
 * part of today's `/uploads/<subdir>/<file>` URL after the prefix, so
 * every URL already stored on a KycDocument / Loan / SystemConfig row
 * maps to a key by slicing a constant, and nothing in the database has
 * to be migrated when the backend changes.
 *
 * ## The threat
 *
 * Keys are derived from user-influenced input (an upload's subdir, a URL
 * read back off a row). On the local adapter a key is joined onto a
 * directory root, so `../../etc/passwd` would read or write outside it.
 * On S3 the same key would silently address a *different object* than
 * intended, because S3 does not normalise `..` — `a/../b` and `b` are
 * two distinct keys, and one of them is not the one the caller checked
 * permissions on.
 *
 * Both are answered the same way: reject rather than sanitise. Silently
 * rewriting a hostile key into a safe one hands the caller a success for
 * a request it did not make, and the rewritten target is still a
 * location the attacker chose. `assertSafeKey` throws, callers surface
 * a 400, and nothing is written.
 */

/** Thrown when a key is malformed or attempts to escape its root. */
export class UnsafeStorageKeyError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Unsafe storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = "UnsafeStorageKeyError";
  }
}

/**
 * Validate a storage key, returning it unchanged.
 *
 * Deliberately strict — this codebase only ever mints keys of the form
 * `<allowlisted-subdir>/<uuid><allowlisted-ext>`, so every rule below
 * rejects something no legitimate caller produces.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new UnsafeStorageKeyError(String(key), "empty");
  }
  // A NUL truncates the path in some syscalls, so `a.png\0.exe` can pass
  // an extension check and land as something else entirely.
  if (key.includes("\0")) {
    throw new UnsafeStorageKeyError(key, "contains NUL");
  }
  // Backslash is a path separator on Windows, where the API also runs in
  // development. `..\..\x` escapes there while looking inert on POSIX.
  if (key.includes("\\")) {
    throw new UnsafeStorageKeyError(key, "contains a backslash");
  }
  // Absolute keys would ignore the root on join(), and `C:` likewise.
  if (key.startsWith("/")) {
    throw new UnsafeStorageKeyError(key, "is absolute");
  }
  if (/^[a-zA-Z]:/.test(key)) {
    throw new UnsafeStorageKeyError(key, "has a drive letter");
  }
  // Percent-encoded separators: a key that survives this check but is
  // decoded later by something downstream is the classic double-decode
  // bug. Nothing here needs `%` at all, so it simply isn't allowed.
  if (key.includes("%")) {
    throw new UnsafeStorageKeyError(key, "contains a percent sign");
  }

  const segments = key.split("/");
  for (const segment of segments) {
    // Empty segment covers a leading, trailing or doubled slash — all of
    // which normalise differently across the two backends.
    if (segment === "") {
      throw new UnsafeStorageKeyError(key, "has an empty path segment");
    }
    if (segment === "." || segment === "..") {
      throw new UnsafeStorageKeyError(key, "has a relative path segment");
    }
  }

  return key;
}

/** Non-throwing form, for callers that want to branch instead. */
export function isSafeKey(key: string): boolean {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}
