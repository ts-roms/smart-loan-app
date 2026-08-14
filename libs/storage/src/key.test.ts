/**
 * Key validation — the traversal gate.
 *
 * Every rejection below corresponds to a way a key derived from user
 * input could address something other than the object the caller
 * intended: an escape out of the uploads root on the local adapter, or
 * a different S3 object than the one whose permissions were checked.
 */

import { describe, expect, it } from "vitest";

import { assertSafeKey, isSafeKey, UnsafeStorageKeyError } from "./key";

describe("assertSafeKey — accepts what the app actually mints", () => {
  it.each([
    "kyc/6f1c2b8a-0000-4000-8000-000000000000.png",
    "branding/logo.svg",
    "signatures/a.png",
    "misc/deeply/nested/but/relative.pdf",
    "a",
  ])("accepts %s", (key) => {
    expect(assertSafeKey(key)).toBe(key);
  });
});

describe("assertSafeKey — rejects traversal", () => {
  const hostile = [
    "../etc/passwd",
    "../../etc/passwd",
    "kyc/../../../etc/passwd",
    "kyc/../branding/logo.svg",
    "kyc/..",
    "..",
    ".",
    "./kyc/a.png",
    "kyc/./a.png",
    // Windows separators — the API runs on Windows in development, where
    // these escape just as effectively as forward slashes.
    "..\\..\\windows\\system32",
    "kyc\\..\\..\\secret.png",
    // Absolute forms ignore the root entirely once joined.
    "/etc/passwd",
    "/uploads/kyc/a.png",
    "C:\\Windows\\System32\\config",
    "C:/Windows/System32/config",
    // Percent-encoded separators, in case anything downstream decodes.
    "kyc/%2e%2e/%2e%2e/etc/passwd",
    "%2Fetc%2Fpasswd",
    // Empty segments normalise inconsistently between the backends.
    "kyc//a.png",
    "/",
    "kyc/",
    "",
    // A NUL truncates the path in some syscalls, so the stored name can
    // differ from the checked one.
    "kyc/a.png\0.exe",
  ];

  it.each(hostile)("rejects %j", (key) => {
    expect(() => assertSafeKey(key)).toThrow(UnsafeStorageKeyError);
    expect(isSafeKey(key)).toBe(false);
  });

  it("names the offending key in the error", () => {
    expect(() => assertSafeKey("../secret")).toThrow(/\.\.\/secret/);
  });
});
