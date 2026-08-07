import type { Notification } from "@loan/shared-types";

/**
 * Where a notification points.
 *
 * Two rules, and the second is the one that was missing.
 *
 * PREFER THE NUMBER. A notification's text already names its subject the
 * way a person would — "Loan disbursed · LN-2026-000006" — while the
 * link went to `/loans/<uuid>`, so one row named the same loan two
 * different ways and the loan page's breadcrumb read "9f31f4ef-cd6…".
 * Loan and customer routes resolve an id OR a reference number, so using
 * the number the message already quotes makes the text, the URL and the
 * crumb agree. `refId` stays the fallback for rows written before
 * `refNumber` existed.
 *
 * POINT AT WHAT THE MESSAGE IS ABOUT. `refType` names the row the
 * notification was keyed on, which is not always the thing the reader
 * wants. "Payment due soon · LN-2026-000006" is keyed on the INSTALMENT;
 * there is no instalment page, and the old switch handled only three
 * types, so it fell through to the customer — six of the nine refTypes
 * in use opened someone's profile instead of the loan they named, or
 * nothing at all.
 *
 * Everything below LOAN_SCOPED is a child of a loan, and the loan is
 * where every one of those messages is asking you to go.
 *
 * Returns null when there is genuinely nothing to point at. The caller
 * renders a plain row then, because a control that looks clickable and
 * isn't is worse than a static one.
 */

/**
 * refTypes that are ABOUT a loan, whatever row they are keyed on.
 *
 * `refNumber` carries the LOAN's number for all of these — see
 * `DispatchInput.refNumber` — so they route by number and land on the
 * loan the message names.
 */
const LOAN_SCOPED = new Set([
  "LoanApplication",
  "LoanSchedule",
  "LeaseAgreement",
  "AnnualDocument",
  "DemandLetter",
  "CoMaker",
]);

export function notificationLink(n: Notification): string | null {
  const ref = n.refNumber ?? n.refId;

  if (n.refType && ref) {
    if (LOAN_SCOPED.has(n.refType)) return `/loans/${ref}`;
    switch (n.refType) {
      case "Customer":
        return `/customers/${ref}`;
      case "User":
        // No per-user detail route; the list is the closest thing.
        return "/users";
      case "Delegation":
        return "/delegations";
    }
  }

  /*
   * An unrecognised refType still usually has a customer worth opening.
   * Deliberately last: it used to catch the six loan types above and
   * quietly send "your payment is overdue on LN-2026-000006" to a
   * profile page.
   */
  return n.customerId ? `/customers/${n.customerId}` : null;
}
