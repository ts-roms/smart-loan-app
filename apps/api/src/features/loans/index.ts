// Loans feature — mounted under /loans.
//
// Two plugins exposed for the central registrar:
//   • loanRoutes — the main loan workflow (apply, decide, disburse,
//     restructure, write-off, payments). Kept as a single routes.ts
//     for now; controller/service split deferred until the file is
//     actively edited again (follow the customers/ canary pattern when
//     that happens).
//   • loanApprovalRoutes — the per-step approval surface
//     (/loans/:id/approvals). Split out here so the matching
//     product-side endpoints can sit in features/loan-products/.
//
// The notify-approvers helper is shared by both above and is colocated
// in this folder.
export { loanRoutes } from "./loans.routes.js";
export { loanApprovalRoutes } from "./approvals.routes.js";
export { notifyApproversForStep } from "./notify-approvers.js";

// Schemas live separately so future consumers (e.g. a bulk-loan
// importer, contract tests, or an alternate REST client) can validate
// the same wire shapes without dragging the route file in.
export * from "./schemas.js";
