/**
 * Public API of the lease feature.
 *
 * Two surfaces:
 *   - `LeaseQueuePage` — the cross-loan dashboard mounted at `/lease`.
 *   - Display constants used by both this feature AND the per-loan
 *     `LeasePanel` that lives inside features/loans (so a label change
 *     touches one file, not two).
 *
 * The per-loan panel itself stays in features/loans because it's
 * loan-scoped UI rendered on the loan detail page. The constants are
 * re-exported here so features/loans can import them without reaching
 * into our internals.
 */

export { LeaseQueuePage } from "./pages/LeaseQueuePage";

export {
  STATUS_LABEL as LEASE_STATUS_LABEL,
  STATUS_VARIANT as LEASE_STATUS_VARIANT,
  TITLE_HOLDER_LABEL as LEASE_TITLE_HOLDER_LABEL,
} from "./constants";
