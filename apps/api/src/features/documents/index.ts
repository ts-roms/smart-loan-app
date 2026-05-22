// Documents feature — PDF rendering for loan agreement, KYC letter,
// statement, etc.
//
// Two plugins exposed for the central registrar:
//   • documentRoutes — officer-side endpoints (no prefix; mounted at
//     the app root).
//   • portalDocumentRoutes — customer-scoped mirror mounted under
//     /portal so a borrower can fetch their own documents.
//
// Both live in one file because they share the bulk of the PDF
// composition and asset-resolution logic.
export { documentRoutes, portalDocumentRoutes } from "./documents.routes";
