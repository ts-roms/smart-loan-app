// Loan products feature — mounted under /loan-products.
//
// Two plugins exposed for the central registrar:
//   • loanProductRoutes — base CRUD + seed.
//   • loanApprovalChainRoutes — the per-product approval workflow
//     definition (lives here because the URL is /loan-products/:code/
//     approval-chain). The matching loan-side endpoints
//     (/loans/:id/approvals) live in features/loans/.
export { loanProductRoutes } from "./loan-products.routes";
export { loanApprovalChainRoutes } from "./approval-chain.routes";
