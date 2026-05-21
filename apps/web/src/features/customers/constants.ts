/**
 * Display-label constants for the customers feature, factored out from
 * the (lazy-loaded) CustomerDetail page so cross-feature consumers
 * (kyc, collections, portal, loans) can read them without pulling the
 * entire page chunk into their own.
 *
 * Why this file exists: an earlier shape had `DOC_TYPE_LABELS` exported
 * directly from `pages/CustomerDetail.tsx`. Every other feature that
 * imported it was getting the full CustomerDetail React component +
 * its hooks + its sub-components dragged into its chunk graph.
 * Rollup would then warn about cross-chunk circular dependencies when
 * the customers barrel re-exported things in the other direction too.
 *
 * Keep this file pure data — no JSX, no React imports — so any chunk
 * can pull it cheaply.
 */
import type { KycDocumentType } from "@loan/shared-types";

export interface DocTypeEntry {
  value: KycDocumentType;
  label: string;
}

export const DOC_TYPES: DocTypeEntry[] = [
  { value: "ID_FRONT", label: "Government ID (front)" },
  { value: "ID_BACK", label: "Government ID (back)" },
  { value: "PROOF_OF_INCOME", label: "Proof of income" },
  { value: "PROOF_OF_ADDRESS", label: "Proof of address" },
  { value: "SELFIE", label: "Selfie holding ID" },
  { value: "VEHICLE_OR", label: "Vehicle OR (Official Receipt)" },
  { value: "VEHICLE_CR", label: "Vehicle CR (Certificate of Registration)" },
  { value: "PROPERTY_TITLE", label: "Property title (TCT/Condo cert)" },
  { value: "TAX_DECLARATION", label: "Tax declaration" },
];

export const DOC_TYPE_LABELS: Record<KycDocumentType, string> =
  Object.fromEntries(DOC_TYPES.map((d) => [d.value, d.label])) as Record<
    KycDocumentType,
    string
  >;
