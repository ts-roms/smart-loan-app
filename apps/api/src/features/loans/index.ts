// Loans feature — mounted under /loans.
//
// Two plugins exposed for the central registrar:
//   • loanRoutes — the main loan workflow (apply, decide, disburse,
//     restructure, write-off, payments). Layered for the workflow paths
//     (apply / decide / disburse / dry-run): loans.controller.ts +
//     loans.service.ts + schemas.ts. The 25-odd routine read endpoints
//     stay inline in loans.routes.ts where they already are.
//   • loanApprovalRoutes — the per-step approval surface
//     (/loans/:id/approvals). Split out here so the matching
//     product-side endpoints can sit in features/loan-products/.
//
// The notify-approvers helper is shared by both above and is colocated
// in this folder.
export { loanRoutes } from "./loans.routes";
export { loanApprovalRoutes } from "./approvals.routes";
export { notifyApproversForStep } from "./notify-approvers";

// Schemas live separately so future consumers (e.g. a bulk-loan
// importer, contract tests, or an alternate REST client) can validate
// the same wire shapes without dragging the route file in.
export * from "./schemas";
