import type { LoanStatus } from "@loan/shared-types";
import { Badge } from "@loan/ui";

/**
 * Visual representation of a loan's status, used in both the list table
 * and the detail header. Re-exported via the feature's public index so
 * other surfaces (e.g. dashboard summary cards) can use the same mapping.
 */
export function LoanStatusBadge({ status }: { status: LoanStatus }) {
  // Terminal-and-bad reads danger; terminal-and-settled reads muted;
  // everything still moving reads warning. WRITTEN_OFF is a loss booked
  // to Bad Debt, so it belongs with the former — and RESTRUCTURED is a
  // closed chapter replaced by a new loan, so it belongs with the latter.
  // Both used to fall through to "warning", which reads as "in progress".
  const variant: "success" | "danger" | "muted" | "warning" =
    status === "APPROVED" || status === "DISBURSED" || status === "ACTIVE"
      ? "success"
      : status === "REJECTED" ||
          status === "DEFAULTED" ||
          status === "CANCELLED" ||
          status === "WRITTEN_OFF"
        ? "danger"
        : status === "CLOSED" || status === "RESTRUCTURED"
          ? "muted"
          : "warning";
  return <Badge variant={variant}>{status}</Badge>;
}
