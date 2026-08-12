import { expect, test } from "@playwright/test";

import { STATE } from "./support";

/**
 * Journey 3 — the customer list and detail render from real responses.
 *
 * `CustomerDetail.guards.test.tsx` feeds this page a hand-built
 * Customer object. It therefore proves the page handles that SHAPE, and
 * proves nothing about whether the API sends it. Rename `archivedAt` on
 * the server and the component suite is still green while the banner
 * silently stops appearing.
 *
 * So the assertions here are about fields arriving, not about wording.
 * The wording is covered one level down, cheaply.
 */

test.use({ storageState: STATE.admin });

test.describe("the customer list", () => {
  test("renders rows with the fields the page reads", async ({ page }) => {
    // Navigate rather than deep-link, so this also covers the nav
    // reaching the list — the route the officer actually takes.
    await page.goto("/");
    await page.getByRole("link", { name: "Customers" }).click();

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    /*
     * A reference number proves more than a row count: it is a real
     * column off a real record, and a list that rendered blank cells
     * would still count rows.
     */
    await expect(page.getByText(/^(CUST|PICKER)-/).first()).toBeVisible();
  });

  test("the search box filters against the API, not just the page", async ({
    page,
  }) => {
    /*
     * Filtering is server-side — the query goes out as `?q=`. A client
     * that stopped sending it would still look like it worked on the
     * first page of results, which is exactly the bug this catches.
     */
    await page.goto("/customers");
    await expect(page.getByRole("table")).toBeVisible();

    const request = page.waitForRequest(
      (r) => r.url().includes("/customers") && /[?&]q=/.test(r.url()),
    );
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill("Clara");
    await request;

    await expect(page.getByText("Clara").first()).toBeVisible();
  });
});

test.describe("a customer's detail page", () => {
  test("opens from the list and shows the record", async ({ page }) => {
    await page.goto("/customers");
    await expect(page.getByRole("table")).toBeVisible();

    const firstNumber = await page
      .getByText(/^(CUST|PICKER)-/)
      .first()
      .textContent();
    await page
      .getByText(/^(CUST|PICKER)-/)
      .first()
      .click();

    // The number the list showed is the number the detail page shows.
    // Two different endpoints, one record — a mismatch here means the
    // list and the detail disagree about who this is.
    await expect(page.getByText(firstNumber!.trim()).first()).toBeVisible();
  });
});
