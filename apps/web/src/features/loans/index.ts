/**
 * Public API of the loans feature.
 *
 * Anything imported from outside the feature must come through this file.
 * Reaching into `./components/…` or `./pages/…` from a sibling feature
 * means we've created an undocumented coupling — the linter and code
 * reviewers should push back.
 */

// Routed pages — consumed by App.tsx
export { LoansListPage } from "./pages/LoansListPage";
export { LoanDetailPage } from "./pages/LoanDetailPage";
export { NewLoanPage } from "./pages/NewLoanPage";
export { LoanDraftsPage } from "./pages/LoanDraftsPage";
// LoanProducts lives in its own feature now — see features/loan-products.

// Reusable surfaces that other features may want to render
// (e.g. a dashboard widget showing a loan's status).
export { LoanStatusBadge } from "./components/StatusBadge";
export { QuickLoanLink } from "./components/QuickLoanDrawer";
// The member portal renders the same ledger against the same payload —
// the portal loan endpoint reuses findByIdOrNumber, so the schedule
// shape is identical. Sharing the component is what keeps a borrower's
// view of their schedule and an officer's from drifting apart.
export { LoanLedgerPanel, ledgerTotals } from "./components/LoanLedgerPanel";
export { ProjectedSchedulePanel } from "./components/ProjectedSchedulePanel";
export type { LedgerRow } from "./components/LoanLedgerPanel";

// Display labels — useful when another feature renders a loan reference
// (e.g. a notification referring to a loan by product). Constants are
// cheaper to share than helper functions: zero behavioral coupling.
export {
  TYPE_LABELS as LOAN_TYPE_LABELS,
  DOC_LABELS as LOAN_DOC_LABELS,
} from "./constants";
