import type { LeaseStatus, LeaseTitleHolder } from "@loan/shared-types";

/**
 * Lease-to-Own display labels — shared between the per-loan panel
 * (features/loans/components/LeasePanel.tsx) and the cross-loan queue.
 * Pulled into the feature's `constants.ts` per the contract in
 * features/README.md so a future copy edit only touches one file.
 */

export const STATUS_LABEL: Record<LeaseStatus, string> = {
  ACTIVE: "Active",
  PULLED_OUT: "Pulled out",
  BUYOUT_COMPLETED: "Buyout completed",
  RETURNED: "Returned",
  EXTENDED: "Extended",
};

export const STATUS_VARIANT: Record<
  LeaseStatus,
  "muted" | "success" | "warning" | "danger"
> = {
  ACTIVE: "muted",
  PULLED_OUT: "danger",
  BUYOUT_COMPLETED: "success",
  RETURNED: "success",
  EXTENDED: "warning",
};

export const TITLE_HOLDER_LABEL: Record<LeaseTitleHolder, string> = {
  COMPANY: "Company",
  CUSTOMER: "Customer",
};
