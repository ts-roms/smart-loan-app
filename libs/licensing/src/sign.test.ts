/**
 * Round-trip + tamper-resistance tests. The whole licensing scheme
 * rests on these holding — if either fails, every other guard in the
 * system can be bypassed by handing the API a hand-rolled token.
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { toBase64Url } from "./codec";
import { defaultFeaturesForTier } from "./features";
import { signLicense, unsafeDecodePayload } from "./sign";
import {
  LICENSE_FORMAT_VERSION,
  LICENSE_TOKEN_PREFIX,
  type LicensePayload,
} from "./types";
import { verifyLicense } from "./verify";

function makePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  const now = Date.now();
  return {
    v: LICENSE_FORMAT_VERSION,
    jti: "test-license-1",
    tenant: "Test Cooperative",
    tier: "ENTERPRISE",
    features: defaultFeaturesForTier("ENTERPRISE"),
    iat: now,
    exp: now + 365 * 24 * 60 * 60 * 1000,
    seats: 0,
    notes: "smoke-test",
    ...overrides,
  };
}

function fakePair() {
  return generateKeyPairSync("ed25519");
}

describe("license sign + verify", () => {
  it("round-trips a valid token", () => {
    const { publicKey, privateKey } = fakePair();
    const payload = makePayload();
    const token = signLicense(payload, privateKey);
    const result = verifyLicense(token, publicKey);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.payload.jti).toBe("test-license-1");
    expect(result.payload.tenant).toBe("Test Cooperative");
    expect(result.payload.tier).toBe("ENTERPRISE");
    expect(result.payload.features).toContain("intel.ai_assistant");
  });

  it("rejects a token signed with a different private key", () => {
    const { privateKey: alice } = fakePair();
    const { publicKey: bobPub } = fakePair();
    const token = signLicense(makePayload(), alice);
    const result = verifyLicense(token, bobPub);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("BadSignature");
  });

  it("rejects a token whose payload was tampered after signing", () => {
    const { publicKey, privateKey } = fakePair();
    const token = signLicense(makePayload({ tier: "BASIC" }), privateKey);

    // Swap the payload section for one that claims ENTERPRISE. The
    // signature was computed over the BASIC payload bytes, so verify
    // must reject.
    const parts = token.split(".");
    const enterprisePayload = Buffer.from(
      JSON.stringify(makePayload({ tier: "ENTERPRISE" })),
      "utf8",
    ).toString("base64url");
    const tampered = `${parts[0]}.${enterprisePayload}.${parts[2]}`;
    const result = verifyLicense(tampered, publicKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("BadSignature");
  });

  it("rejects an expired license", () => {
    const { publicKey, privateKey } = fakePair();
    const past = Date.now() - 1000;
    const token = signLicense(
      makePayload({ iat: past - 100_000, exp: past }),
      privateKey,
    );
    const result = verifyLicense(token, publicKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("Expired");
  });

  it("rejects a not-yet-active license", () => {
    const { publicKey, privateKey } = fakePair();
    const future = Date.now() + 60_000;
    const token = signLicense(
      makePayload({ nbf: future, exp: future + 1_000_000 }),
      privateKey,
    );
    const result = verifyLicense(token, publicKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotYetActive");
  });

  it("rejects a wrong-format-version token", () => {
    // Build the token by hand — signLicense() refuses to mint
    // mismatched-version tokens (that's the platform's own guard).
    // What we're testing here is the VERIFIER catching a hand-crafted
    // token whose attacker happened to control the private key.
    const { publicKey, privateKey } = fakePair();
    const payload = { ...makePayload(), v: 99 };
    const payloadB64 = toBase64Url(JSON.stringify(payload));
    const signature = cryptoSign(
      null,
      Buffer.from(payloadB64, "utf8"),
      privateKey,
    );
    const token = `${LICENSE_TOKEN_PREFIX}.${payloadB64}.${toBase64Url(signature)}`;
    const result = verifyLicense(token, publicKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("WrongVersion");
  });

  it("rejects a missing-prefix token (random JWT pasted in)", () => {
    const { publicKey } = fakePair();
    const result = verifyLicense(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc",
      publicKey,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("MalformedToken");
  });

  it("unsafeDecodePayload returns the payload without verifying", () => {
    const { privateKey } = fakePair();
    const token = signLicense(makePayload(), privateKey);
    const decoded = unsafeDecodePayload(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.tier).toBe("ENTERPRISE");
  });
});
