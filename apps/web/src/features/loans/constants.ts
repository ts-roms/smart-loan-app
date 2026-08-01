import type { KycDocumentType } from "@loan/shared-types";

/**
 * Short human labels for the canonical product codes. Codes outside this
 * map fall back to the raw code string at render time.
 */
export const TYPE_LABELS: Record<string, string> = {
  SALARY: "Salary",
  AUTOMOTIVE: "Auto",
  MOTORCYCLE: "Motorcycle",
  HOUSING: "Housing",
};

/** Display labels for the KYC document types the loans flow surfaces. */
export const DOC_LABELS: Record<KycDocumentType, string> = {
  ID_FRONT: "ID (front)",
  ID_BACK: "ID (back)",
  PROOF_OF_INCOME: "Proof of income",
  PROOF_OF_ADDRESS: "Proof of address",
  SELFIE: "Selfie",
  VEHICLE_OR: "Vehicle OR",
  VEHICLE_CR: "Vehicle CR",
  PROPERTY_TITLE: "Property title",
  TAX_DECLARATION: "Tax declaration",
};
