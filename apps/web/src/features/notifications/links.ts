import type { Notification } from "@loan/shared-types";

/**
 * Where a notification points.
 *
 * Notifications carry `refType`/`refId` naming the entity they were
 * raised about, plus an optional `customerId`. Both go unused on
 * screen, which made the list a wall of text you had to read and then
 * go find the loan yourself.
 *
 * Route params accept an id or a reference number (`idOrNumberWhere`),
 * so the stored UUID works directly — no lookup needed to build these.
 *
 * Returns null when there's nothing to point at. The caller renders a
 * plain row in that case rather than a link that goes nowhere, because
 * a control that looks clickable and isn't is worse than a static one.
 */
export function notificationLink(n: Notification): string | null {
  if (n.refId) {
    switch (n.refType) {
      case "LoanApplication":
        return `/loans/${n.refId}`;
      case "Customer":
        return `/customers/${n.refId}`;
      case "User":
        // No per-user detail route; the list is the closest thing.
        return "/users";
    }
  }
  // An unrecognised refType still usually has a customer worth opening.
  return n.customerId ? `/customers/${n.customerId}` : null;
}
