import type { KycDocumentType, LoanStatus } from "@loan/shared-types";

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

/**
 * Status choices for the loans list filter, in lifecycle order rather
 * than the enum's declaration order — an officer scanning the dropdown is
 * thinking "where is this loan in its life", not "what did the schema
 * author type first".
 */
export const LOAN_STATUS_OPTIONS: ReadonlyArray<{
  value: LoanStatus;
  label: string;
}> = [
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "APPROVED", label: "Approved" },
  { value: "DISBURSED", label: "Disbursed" },
  { value: "ACTIVE", label: "Active" },
  { value: "CLOSED", label: "Closed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "DEFAULTED", label: "Defaulted" },
  { value: "RESTRUCTURED", label: "Restructured" },
  { value: "WRITTEN_OFF", label: "Written off" },
];

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
