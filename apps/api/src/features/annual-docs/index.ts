// Annual / renewable documents feature (FRD §3.8).
//
// Two plugins exposed for the central registrar:
//   • annualDocsLoanRoutes — per-loan endpoints mounted under /loans
//     so paths read /loans/:loanId/annual-docs.
//   • annualDocsRoutes — cross-loan dashboard endpoints mounted under
//     /annual-docs.
//
// Both share the same repository and document-status logic so they
// live in one routes file.
export {
  annualDocsLoanRoutes,
  annualDocsRoutes,
} from "./annual-docs.routes.js";
