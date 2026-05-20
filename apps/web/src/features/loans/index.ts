/**
 * Public API of the loans feature.
 *
 * Anything imported from outside the feature must come through this file.
 * Reaching into `./components/…` or `./pages/…` from a sibling feature
 * means we've created an undocumented coupling — the linter and code
 * reviewers should push back.
 */

// Routed pages — consumed by App.tsx
export { LoansListPage } from './pages/LoansListPage';
export { LoanDetailPage } from './pages/LoanDetailPage';
// LoanProducts lives in its own feature now — see features/loan-products.

// Reusable surfaces that other features may want to render
// (e.g. a dashboard widget showing a loan's status).
export { LoanStatusBadge } from './components/StatusBadge';
export { QuickLoanLink } from './components/QuickLoanDrawer';

// Display labels — useful when another feature renders a loan reference
// (e.g. a notification referring to a loan by product). Constants are
// cheaper to share than helper functions: zero behavioral coupling.
export { TYPE_LABELS as LOAN_TYPE_LABELS, DOC_LABELS as LOAN_DOC_LABELS } from './constants';
