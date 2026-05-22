import {
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import { fromBase64Url, toBase64Url } from "./codec";
import {
  LICENSE_FORMAT_VERSION,
  LICENSE_TOKEN_PREFIX,
  type LicensePayload,
} from "./types";

/**
 * Sign a license payload with the platform's Ed25519 private key.
 * Returns the wire-format token:
 *
 *   SMARTLOAN-LIC-v1.<base64url(payload-json)>.<base64url(signature)>
 *
 * The format is JWS-shaped but deliberately not JWT — we want the
 * eye-catching prefix so a customer doesn't paste a stray JWT from
 * somewhere else into the activation field and get a confusing
 * "BadSignature" error.
 *
 * Throws when the key isn't a valid Ed25519 private key. There's no
 * happy-path failure mode here; if signing fails, the platform has
 * misconfigured its keys and that's a deploy-time problem, not a
 * runtime one.
 */
export function signLicense(
  payload: LicensePayload,
  privateKey: KeyObject | string | Buffer,
): string {
  if (payload.v !== LICENSE_FORMAT_VERSION) {
    throw new Error(
      `License payload version mismatch: expected ${LICENSE_FORMAT_VERSION}, got ${payload.v}`,
    );
  }
  const key =
    typeof privateKey === "string" || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey;

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `License signing key must be Ed25519, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(payloadJson);
  // Ed25519's sign() doesn't take a hash algorithm — pass null. The
  // input we sign is the base64url'd payload bytes, NOT the raw JSON,
  // so verify() can be a single decode on the wire token.
  const signature = cryptoSign(null, Buffer.from(payloadB64, "utf8"), key);
  const signatureB64 = toBase64Url(signature);
  return `${LICENSE_TOKEN_PREFIX}.${payloadB64}.${signatureB64}`;
}

/**
 * Convenience: round-trip a signed token's payload without verifying
 * the signature. Useful in scripts that want to inspect what a token
 * would unlock. NEVER use this in the API verify path — the
 * unsigned payload is attacker-controlled.
 */
export function unsafeDecodePayload(token: string): LicensePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_TOKEN_PREFIX) return null;
  try {
    const json = fromBase64Url(parts[1]!).toString("utf8");
    return JSON.parse(json) as LicensePayload;
  } catch {
    return null;
  }
}
