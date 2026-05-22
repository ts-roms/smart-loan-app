import { createHash, randomBytes } from "node:crypto";

/**
 * JWT TTL for the access token. Short-ish — the refresh flow handles
 * extending sessions beyond this.
 */
export const ACCESS_TOKEN_TTL = "24h";

/** Refresh tokens are valid for 30 days. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Authenticator display name shown in the user's authenticator app
 * (Google Authenticator / Authy / 1Password). Overridable via env so a
 * tenant deploy doesn't have to fork the constant.
 */
export const TOTP_ISSUER = process.env.TOTP_ISSUER ?? "SmartLoan";

/**
 * Generate an opaque refresh token. 64 random bytes → 88 base64url
 * chars. The raw token is returned to the client; only its SHA-256 is
 * persisted, so a DB compromise doesn't yield session-replay material.
 */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(64).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** SHA-256 of a raw refresh token. Used at refresh + logout lookup time. */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Normalise a recovery code into the hash form we persist. Strips
 * whitespace + dashes and uppercases before hashing, so "abcd-1234",
 * "ABCD1234", "abcd 1234" all match the same stored hash.
 */
export function hashRecoveryCode(raw: string): string {
  return createHash("sha256")
    .update(raw.replace(/\s|-/g, "").toUpperCase())
    .digest("hex");
}

/**
 * Generate N single-use recovery codes. Returns the codes for one-time
 * display to the user AND their hashes for persistence. Format:
 * XXXX-XXXX (8 alphanumeric chars + a dash for readability).
 */
export function generateRecoveryCodes(n: number): {
  codes: string[];
  hashes: string[];
} {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(5)
      .toString("base64url")
      .replace(/[^A-Z0-9]/gi, "")
      .slice(0, 8)
      .toUpperCase();
    const display =
      raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    codes.push(display);
    hashes.push(createHash("sha256").update(raw).digest("hex"));
  }
  return { codes, hashes };
}
