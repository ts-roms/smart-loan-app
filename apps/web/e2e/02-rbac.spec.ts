import { expect, test } from "@playwright/test";

import { STATE } from "./support";

/**
 * Journey 2 — the UI and the API agree about who may do what.
 *
 * `use-permission.test.tsx` proves the hook returns false for a
 * permission the user lacks. What it cannot prove is that the key the
 * component asks for is a key the API actually issues. `loans.apply` in
 * the component and `loan.apply` in the RBAC seed both pass every unit
 * test and hide the button from everybody.
 *
 * So this journey asserts on the difference between two REAL roles
 * rather than on a permission list. A typo makes the collector's view
 * and the admin's view identical, and that is what fails here.
 */

test.describe("a collector", () => {
  test.use({ storageState: STATE.collector });

  test("does not see the admin surfaces an admin does", async ({ page }) => {
    await page.goto("/");

    // Their own work is reachable.
    await expect(page.getByRole("link", { name: "Collections" })).toBeVisible();

    // Underwriting policy and staff administration are not.
    await expect(
      page.getByRole("link", { name: "Decision rules" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Users", exact: true }),
    ).toHaveCount(0);
  });

  test("can READ the decision rules but not change them", async ({ page }) => {
    /*
     * Reaching this URL directly works, and is meant to: reading the
     * rules is gated on `loans.read`, which any staff member explaining
     * a decision needs. Only CHANGING them is `admin.decision_rules`.
     *
     * The nav link is hidden anyway, which reads as an inconsistency
     * and is a deliberate one — the sidebar is an editor's index, not a
     * statement about what is legible.
     *
     * So the invariant worth asserting is the split, end to end: the
     * page renders from a real API response the collector was allowed
     * to fetch, and offers them nothing to press. A single mistyped key
     * on either gate collapses that into all-or-nothing.
     */
    await page.goto("/decision-rules");

    // The rules loaded — this is a real API response, not an empty
    // table that would pass a weaker assertion.
    await expect(page.getByText("AML hard-block")).toBeVisible();

    await expect(page.getByRole("button", { name: /new rule/i })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /retire/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^edit$/i })).toHaveCount(0);
  });
});

test.describe("an admin", () => {
  test.use({ storageState: STATE.admin });

  test("sees both", async ({ page }) => {
    // The positive control. Without it, a nav that rendered no links at
    // all would pass every assertion above.
    await page.goto("/");

    await expect(
      page.getByRole("link", { name: "Decision rules" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Users", exact: true }),
    ).toBeVisible();
  });
});
