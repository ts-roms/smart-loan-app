// Public API of the customers feature.
//
// Routed pages — referenced from App.tsx (lazy-loaded).
export { CustomersPage } from "./pages/Customers";
export { CustomerDetailPage } from "./pages/CustomerDetail";
export { CreditSurveyPage } from "./pages/CreditSurvey";
export { BulkCustomersPage } from "./pages/BulkCustomers";

// Cross-feature surfaces. Each is its own small module so consumers
// don't pull a routed page into their chunk just to use a constant or
// a drawer component. Cross-feature imports SHOULD import directly
// from the source modules below — Rollup will warn otherwise about
// circular chunk dependencies. Re-exports here exist for ergonomic
// in-feature use only.
export { DOC_TYPES, DOC_TYPE_LABELS } from "./constants";
export { CustomerSummaryLink } from "./components/CustomerSummaryDrawer";
