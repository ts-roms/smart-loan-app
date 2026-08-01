import {
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import { fromBase64Url } from "./codec";
import {
  FEATURE_FLAGS,
  LICENSE_FORMAT_VERSION,
  LICENSE_TIERS,
  LICENSE_TOKEN_PREFIX,
  type FeatureFlag,
  type LicensePayload,
  type LicenseTier,
  type VerifyResult,
} from "./types";

/**
 * Verify a license token against the platform's Ed25519 public key.
 *
 * Returns a discriminated result rather than throwing — the caller
 * (boot hook, activation endpoint) wants to display the specific
 * failure to the operator, not catch an exception and lose the reason.
 *
 * Validation order matters: format → signature → schema → temporal.
 * Signature is checked before schema so a malformed payload from an
 * unsigned source gets the more useful "BadSignature" verdict instead
 * of "InvalidPayload" (which could imply the platform issued bad data).
 */
export function verifyLicense(
  token: string,
  publicKey: KeyObject | string | Buffer,
  /** Override for tests. Defaults to wall-clock now in ms. */
  now: number = Date.now(),
): VerifyResult {
  // 1. Format
  if (
    typeof token !== "string" ||
    !token.startsWith(`${LICENSE_TOKEN_PREFIX}.`)
  ) {
    return {
      ok: false,
      kind: "MalformedToken",
      message: `Token must start with "${LICENSE_TOKEN_PREFIX}."`,
    };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      kind: "MalformedToken",
      message: `Token must be in the form ${LICENSE_TOKEN_PREFIX}.<payload>.<signature>`,
    };
  }
  const [, payloadB64, signatureB64] = parts as [string, string, string];

  // 2. Signature — verify the bytes that were signed (the b64 payload).
  const key =
    typeof publicKey === "string" || Buffer.isBuffer(publicKey)
      ? createPublicKey(publicKey)
      : publicKey;
  if (key.asymmetricKeyType !== "ed25519") {
    return {
      ok: false,
      kind: "BadSignature",
      message: `License public key must be Ed25519, got ${key.asymmetricKeyType ?? "unknown"}`,
    };
  }
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(payloadB64, "utf8"),
      key,
      fromBase64Url(signatureB64),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: false,
      kind: "BadSignature",
      message: "Signature does not match this platform's public key.",
    };
  }

  // 3. Schema — narrow the parsed JSON into a LicensePayload.
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(payloadB64).toString("utf8"));
  } catch {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "Payload is not valid JSON.",
    };
  }
  const schemaCheck = validatePayloadShape(raw);
  if (!schemaCheck.ok) return schemaCheck;
  const payload = schemaCheck.payload;

  // 4. Temporal — nbf / exp.
  if (payload.nbf !== undefined && now < payload.nbf) {
    return {
      ok: false,
      kind: "NotYetActive",
      message: `License is not active until ${new Date(payload.nbf).toISOString()}.`,
    };
  }
  if (now >= payload.exp) {
    return {
      ok: false,
      kind: "Expired",
      message: `License expired on ${new Date(payload.exp).toISOString()}.`,
    };
  }

  return { ok: true, payload };
}

/**
 * Narrow `unknown` into a LicensePayload, or return a typed failure.
 * Hand-rolled rather than zod-imported to keep this lib dependency-
 * free (so the web app can use the same code path for the eventual
 * "what would this token unlock" preview without pulling in zod).
 */
function validatePayloadShape(
  raw: unknown,
):
  | { ok: true; payload: LicensePayload }
  | { ok: false; kind: "WrongVersion" | "InvalidPayload"; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "Payload is not an object.",
    };
  }
  const o = raw as Record<string, unknown>;

  if (o.v !== LICENSE_FORMAT_VERSION) {
    return {
      ok: false,
      kind: "WrongVersion",
      message: `License format version mismatch: this build expects v${LICENSE_FORMAT_VERSION}, token is v${String(o.v)}.`,
    };
  }
  if (typeof o.jti !== "string" || o.jti.length === 0) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "Missing or invalid `jti`.",
    };
  }
  if (typeof o.tenant !== "string" || o.tenant.length === 0) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "Missing or invalid `tenant`.",
    };
  }
  if (
    typeof o.tier !== "string" ||
    !(LICENSE_TIERS as readonly string[]).includes(o.tier)
  ) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: `Unknown tier: ${String(o.tier)}.`,
    };
  }
  if (!Array.isArray(o.features)) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "`features` must be an array.",
    };
  }
  const knownFlags = new Set<string>(FEATURE_FLAGS);
  const features: FeatureFlag[] = [];
  for (const f of o.features) {
    if (typeof f !== "string") {
      return {
        ok: false,
        kind: "InvalidPayload",
        message: "`features` must contain strings.",
      };
    }
    // Unknown flags are dropped silently — they're either from a
    // newer payload version or a typo. We don't reject the whole
    // license over an extra flag.
    if (knownFlags.has(f)) features.push(f as FeatureFlag);
  }
  if (typeof o.iat !== "number" || typeof o.exp !== "number") {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "`iat` and `exp` must be numbers (unix ms).",
    };
  }
  if (o.nbf !== undefined && typeof o.nbf !== "number") {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "`nbf` must be a number when present.",
    };
  }
  if (
    typeof o.seats !== "number" ||
    o.seats < 0 ||
    !Number.isInteger(o.seats)
  ) {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "`seats` must be a non-negative integer.",
    };
  }
  if (o.notes !== undefined && typeof o.notes !== "string") {
    return {
      ok: false,
      kind: "InvalidPayload",
      message: "`notes` must be a string when present.",
    };
  }

  return {
    ok: true,
    payload: {
      v: LICENSE_FORMAT_VERSION,
      jti: o.jti,
      tenant: o.tenant,
      tier: o.tier as LicenseTier,
      features,
      iat: o.iat,
      nbf: o.nbf,
      exp: o.exp,
      seats: o.seats,
      notes: o.notes,
    },
  };
}
