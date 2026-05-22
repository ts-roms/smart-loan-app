import { describe, expect, it } from "vitest";

import {
  REQUIRED_DOCS,
  requiredDocsFor,
  validateKyc,
  type KycSubmissionLite,
} from "./index";

/**
 * Unit tests for the KYC rollup. `validateKyc` is the single source of
 * truth for whether a customer's KYC pack is complete — every gate
 * (loan apply, decide, disburse) reads it — so the matrix below covers
 * the rollup's five interesting states: NONE / PENDING / VERIFIED /
 * REJECTED, plus the per-product extras path.
 */

function s(
  documentType: KycSubmissionLite["documentType"],
  status: KycSubmissionLite["status"],
): KycSubmissionLite {
  return { documentType, status };
}

describe("requiredDocsFor", () => {
  it("returns the base pack when no extras are passed", () => {
    expect(requiredDocsFor()).toEqual(REQUIRED_DOCS);
  });

  it("merges and dedupes extras with the base pack", () => {
    const merged = requiredDocsFor(["VEHICLE_OR", "ID_FRONT"]);
    // Should add VEHICLE_OR once; ID_FRONT is already in the base.
    expect(merged).toContain("VEHICLE_OR");
    expect(merged.filter((d) => d === "ID_FRONT")).toHaveLength(1);
  });
});

describe("validateKyc — base pack rollup", () => {
  it("reports NONE + all base docs missing when no submissions exist", () => {
    const r = validateKyc([]);
    expect(r.status).toBe("NONE");
    expect(r.complete).toBe(false);
    expect(r.missing.sort()).toEqual([...REQUIRED_DOCS].sort());
    expect(r.rejected).toEqual([]);
  });

  it("is PENDING when at least one required doc is missing", () => {
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"),
      s("PROOF_OF_INCOME", "VERIFIED"),
      // PROOF_OF_ADDRESS missing
    ]);
    expect(r.status).toBe("PENDING");
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["PROOF_OF_ADDRESS"]);
    expect(r.rejected).toEqual([]);
  });

  it("is PENDING when a required doc is still PENDING (not yet decided)", () => {
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"),
      s("PROOF_OF_INCOME", "PENDING"),
      s("PROOF_OF_ADDRESS", "VERIFIED"),
    ]);
    expect(r.status).toBe("PENDING");
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("is VERIFIED when every base doc is VERIFIED", () => {
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"),
      s("PROOF_OF_INCOME", "VERIFIED"),
      s("PROOF_OF_ADDRESS", "VERIFIED"),
    ]);
    expect(r.status).toBe("VERIFIED");
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("is REJECTED when any required doc was rejected, even if others verify", () => {
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"),
      s("PROOF_OF_INCOME", "REJECTED"),
      s("PROOF_OF_ADDRESS", "VERIFIED"),
    ]);
    expect(r.status).toBe("REJECTED");
    expect(r.complete).toBe(false);
    expect(r.rejected).toEqual(["PROOF_OF_INCOME"]);
  });

  it("ignores REJECTED on non-required docs (SELFIE here is optional)", () => {
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"),
      s("PROOF_OF_INCOME", "VERIFIED"),
      s("PROOF_OF_ADDRESS", "VERIFIED"),
      s("SELFIE", "REJECTED"),
    ]);
    expect(r.status).toBe("VERIFIED");
    expect(r.complete).toBe(true);
  });

  it("treats the first submission per documentType as the source of truth (DESC order)", () => {
    // Caller queries DESC by submittedAt; we pick the first entry per type.
    // A newer VERIFIED should override an older REJECTED for the same type.
    const r = validateKyc([
      s("ID_FRONT", "VERIFIED"), // newest — wins
      s("ID_FRONT", "REJECTED"), // older, ignored
      s("PROOF_OF_INCOME", "VERIFIED"),
      s("PROOF_OF_ADDRESS", "VERIFIED"),
    ]);
    expect(r.status).toBe("VERIFIED");
    expect(r.rejected).toEqual([]);
  });
});

describe("validateKyc — per-product extras", () => {
  it("requires the per-product extras on top of the base pack", () => {
    // Vehicle loan product requires OR + CR on top of the base.
    const r = validateKyc(
      [
        s("ID_FRONT", "VERIFIED"),
        s("PROOF_OF_INCOME", "VERIFIED"),
        s("PROOF_OF_ADDRESS", "VERIFIED"),
        // VEHICLE_OR missing → PENDING for this product
      ],
      ["VEHICLE_OR", "VEHICLE_CR"],
    );
    expect(r.status).toBe("PENDING");
    expect(r.missing).toContain("VEHICLE_OR");
    expect(r.missing).toContain("VEHICLE_CR");
  });

  it("is VERIFIED only when every base + extras doc is verified", () => {
    const r = validateKyc(
      [
        s("ID_FRONT", "VERIFIED"),
        s("PROOF_OF_INCOME", "VERIFIED"),
        s("PROOF_OF_ADDRESS", "VERIFIED"),
        s("VEHICLE_OR", "VERIFIED"),
        s("VEHICLE_CR", "VERIFIED"),
      ],
      ["VEHICLE_OR", "VEHICLE_CR"],
    );
    expect(r.status).toBe("VERIFIED");
    expect(r.complete).toBe(true);
  });

  it("flags REJECTED on an extras doc the same as on a base doc", () => {
    const r = validateKyc(
      [
        s("ID_FRONT", "VERIFIED"),
        s("PROOF_OF_INCOME", "VERIFIED"),
        s("PROOF_OF_ADDRESS", "VERIFIED"),
        s("VEHICLE_OR", "REJECTED"),
        s("VEHICLE_CR", "VERIFIED"),
      ],
      ["VEHICLE_OR", "VEHICLE_CR"],
    );
    expect(r.status).toBe("REJECTED");
    expect(r.rejected).toEqual(["VEHICLE_OR"]);
  });
});
