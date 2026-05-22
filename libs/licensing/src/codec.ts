/**
 * Pure encoding helpers. base64url (RFC 4648) is JWT-compatible and
 * URL-safe, so a license token can ride in URLs or be pasted into a
 * textarea without escaping problems.
 *
 * Node 16+ has native Buffer.toString("base64url") / Buffer.from(..,
 * "base64url"); we wrap them so callers in libs / scripts / tests
 * have a single import.
 */

export function toBase64Url(input: Buffer | Uint8Array | string): string {
  const buf =
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

export function fromBase64Url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}
