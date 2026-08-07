import { describe, expect, it } from "vitest";

import { notificationLink } from "./links";
import type { Notification } from "@loan/shared-types";

const n = (over: Partial<Notification>): Notification => ({
  id: "n1",
  event: "LOAN_DISBURSED",
  channel: "EMAIL",
  recipient: "a@b.test",
  subject: null,
  body: "",
  status: "SENT",
  providerRef: null,
  error: null,
  refType: null,
  refId: null,
  refNumber: null,
  customerId: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  sentAt: null,
  ...over,
});

describe("notificationLink", () => {
  /**
   * The text says "LN-2026-000006" and the link used to say
   * "/loans/9f31f4ef-cd6b-…", so the same row named the same loan two
   * different ways and the breadcrumb rendered a truncated uuid.
   */
  it("prefers the number the message already quotes", () => {
    expect(
      notificationLink(
        n({
          refType: "LoanApplication",
          refId: "9f31f4ef-cd6b-4bf9-a594-9b722e2004b5",
          refNumber: "LN-2026-000006",
        }),
      ),
    ).toBe("/loans/LN-2026-000006");
  });

  it("falls back to the id on rows written before refNumber existed", () => {
    expect(
      notificationLink(n({ refType: "LoanApplication", refId: "uuid-1" })),
    ).toBe("/loans/uuid-1");
  });

  /**
   * The routing bug. These are keyed on a child row — an instalment, a
   * lease, an annual document — and there is no page for any of them.
   * The old switch handled three refTypes and let the other six fall
   * through to the customer, so "your payment is overdue on
   * LN-2026-000006" opened a profile page instead of the loan.
   */
  it.each([
    "LoanSchedule",
    "LeaseAgreement",
    "AnnualDocument",
    "DemandLetter",
    "CoMaker",
  ])("routes a %s notification to the loan it names", (refType) => {
    expect(
      notificationLink(
        n({
          refType,
          refId: "child-row-id",
          refNumber: "LN-2026-000006",
          // Present, and must NOT win — that fallback is what was
          // swallowing all of these.
          customerId: "cust-1",
        }),
      ),
    ).toBe("/loans/LN-2026-000006");
  });

  it("routes a customer notification by number", () => {
    expect(
      notificationLink(
        n({ refType: "Customer", refId: "u", refNumber: "CUST-2026-000123" }),
      ),
    ).toBe("/customers/CUST-2026-000123");
  });

  it("sends user and delegation rows to their list pages", () => {
    expect(notificationLink(n({ refType: "User", refId: "u1" }))).toBe(
      "/users",
    );
    expect(notificationLink(n({ refType: "Delegation", refId: "d1" }))).toBe(
      "/delegations",
    );
  });

  it("falls back to the customer only for an unknown refType", () => {
    expect(
      notificationLink(
        n({ refType: "SomethingNew", refId: "x", customerId: "cust-1" }),
      ),
    ).toBe("/customers/cust-1");
  });

  it("returns null when there is nothing to point at", () => {
    // The caller renders a plain row then — a control that looks
    // clickable and isn't is worse than a static one.
    expect(notificationLink(n({}))).toBeNull();
    expect(notificationLink(n({ refType: "LoanApplication" }))).toBeNull();
  });
});
