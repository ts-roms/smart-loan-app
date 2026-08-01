export type KycDocumentType =
  | "ID_FRONT"
  | "ID_BACK"
  | "PROOF_OF_INCOME"
  | "PROOF_OF_ADDRESS"
  | "SELFIE"
  | "VEHICLE_OR"
  | "VEHICLE_CR"
  | "PROPERTY_TITLE"
  | "TAX_DECLARATION";

export type KycSubmissionStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface KycSubmissionLite {
  documentType: KycDocumentType;
  status: KycSubmissionStatus;
}

export interface KycValidationResult {
  /** True only if every required doc is VERIFIED. */
  complete: boolean;
  /** PENDING / VERIFIED / REJECTED rollup, mirrors Customer.kycStatus. */
  status: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  missing: KycDocumentType[];
  rejected: KycDocumentType[];
}

/**
 * Base required documents to verify a customer for any product. ID_BACK and
 * SELFIE remain optional today — flip them into REQUIRED when underwriting
 * policy tightens.
 */
export const REQUIRED_DOCS: KycDocumentType[] = [
  "ID_FRONT",
  "PROOF_OF_INCOME",
  "PROOF_OF_ADDRESS",
];

/** Union of base + caller-supplied extras, deduplicated. */
export function requiredDocsFor(
  extraRequired: KycDocumentType[] = [],
): KycDocumentType[] {
  return [...new Set([...REQUIRED_DOCS, ...extraRequired])];
}

/**
 * Computes a customer's KYC posture from their submissions. Pure — no DB
 * access — so it works in both the API (route hands in the rows) and the
 * web (client could call this on cached data if we ever ship offline KYC).
 *
 * `extraRequired` is the product-specific list pulled from
 * `LoanProduct.requiredKycDocs`. Pass `[]` (or omit) for the customer-level
 * rollup that only checks the base pack.
 */
export function validateKyc(
  submissions: KycSubmissionLite[],
  extraRequired: KycDocumentType[] = [],
): KycValidationResult {
  const required = requiredDocsFor(extraRequired);
  if (submissions.length === 0) {
    return {
      complete: false,
      status: "NONE",
      missing: [...required],
      rejected: [],
    };
  }
  // Latest decision wins per type. The caller sorts; we take .find() which
  // returns the first match — DB queries here come ordered DESC by date.
  const byType = new Map<KycDocumentType, KycSubmissionLite>();
  for (const s of submissions)
    if (!byType.has(s.documentType)) byType.set(s.documentType, s);

  const rejected = required.filter((t) => byType.get(t)?.status === "REJECTED");
  const missing = required.filter((t) => !byType.has(t));
  const allVerified = required.every(
    (t) => byType.get(t)?.status === "VERIFIED",
  );

  if (rejected.length > 0)
    return { complete: false, status: "REJECTED", missing, rejected };
  if (allVerified)
    return { complete: true, status: "VERIFIED", missing: [], rejected: [] };
  return { complete: false, status: "PENDING", missing, rejected: [] };
}
