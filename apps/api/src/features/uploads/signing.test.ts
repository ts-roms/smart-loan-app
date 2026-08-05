import { describe, expect, it } from "vitest";

import {
  isProtectedUploadPath,
  signUploadPath,
  verifyUploadSignature,
} from "./signing";

const KYC = "/uploads/kyc/6f1c2b8a-0000-4000-8000-000000000000.png";
const LOGO = "/uploads/branding/logo.svg";

describe("isProtectedUploadPath", () => {
  it("protects the subdirs that hold personal data", () => {
    for (const sub of ["kyc", "selfies", "collateral", "signatures"]) {
      expect(isProtectedUploadPath(`/uploads/${sub}/file.png`)).toBe(true);
    }
  });

  it("leaves branding public — the logo renders before login", () => {
    expect(isProtectedUploadPath(LOGO)).toBe(false);
  });

  it("protects misc, the unclassified catch-all", () => {
    expect(isProtectedUploadPath("/uploads/misc/file.pdf")).toBe(true);
  });

  it("treats an unknown subdir as protected", () => {
    // Fail closed: an unrecognized shape is a bug or an attempt to
    // slip past the check, and neither should reach the public branch.
    expect(isProtectedUploadPath("/uploads/whatever/file.png")).toBe(true);
    expect(isProtectedUploadPath("/uploads/file.png")).toBe(true);
  });
});

describe("signUploadPath / verifyUploadSignature", () => {
  const now = 1_800_000_000_000;

  function parse(url: string) {
    const [pathname, query] = url.split("?");
    const params = new URLSearchParams(query);
    return {
      pathname: pathname!,
      exp: params.get("exp") ?? undefined,
      sig: params.get("sig") ?? undefined,
    };
  }

  it("round-trips a freshly minted signature", () => {
    const { url } = signUploadPath(KYC, 60_000, now);
    const p = parse(url);
    expect(verifyUploadSignature(p.pathname, p.exp, p.sig, now)).toBe("ok");
  });

  it("reports expiry separately so the client knows to re-sign", () => {
    const { url } = signUploadPath(KYC, 60_000, now);
    const p = parse(url);
    expect(verifyUploadSignature(p.pathname, p.exp, p.sig, now + 60_001)).toBe(
      "expired",
    );
  });

  it("rejects a signature minted for a different file", () => {
    // The whole point: one document's URL must not open another's.
    const { url } = signUploadPath(KYC, 60_000, now);
    const p = parse(url);
    const other = "/uploads/kyc/11111111-0000-4000-8000-000000000000.png";
    expect(verifyUploadSignature(other, p.exp, p.sig, now)).toBe("invalid");
  });

  it("rejects an extended expiry", () => {
    // Expiry is inside the signed payload, so moving it invalidates.
    const { url } = signUploadPath(KYC, 60_000, now);
    const p = parse(url);
    const later = String(Number(p.exp) + 60_000);
    expect(verifyUploadSignature(p.pathname, later, p.sig, now)).toBe(
      "invalid",
    );
  });

  it("rejects missing and malformed parameters", () => {
    expect(verifyUploadSignature(KYC, undefined, undefined, now)).toBe(
      "missing",
    );
    expect(verifyUploadSignature(KYC, "not-a-number", "abc", now)).toBe(
      "invalid",
    );
    expect(verifyUploadSignature(KYC, String(now + 1000), "", now)).toBe(
      "missing",
    );
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch — the guard in
    // verify has to catch that before it reaches the compare.
    expect(() =>
      verifyUploadSignature(KYC, String(now + 1000), "short", now),
    ).not.toThrow();
    expect(verifyUploadSignature(KYC, String(now + 1000), "short", now)).toBe(
      "invalid",
    );
  });
});
