import { expect, test } from "@playwright/test";

import { STATE } from "./support";

/**
 * Journey 4 — the version history reaches the page from the real
 * endpoint.
 *
 * `GET /decision-rules/:id/versions` was added in the same change as
 * the panel that reads it, which is exactly the situation where a
 * component test proves the least: it was written against the shape the
 * component wanted, and the endpoint was written to a shape the author
 * remembered. Both pass in isolation; only a live round trip shows they
 * agree.
 *
 * The migration backfilled a version 1 for every rule, so every rule in
 * a seeded database has history whether or not anyone has edited it —
 * which is what makes this assertable without writing anything.
 */

test.use({ storageState: STATE.admin });

test.describe("decision rule history", () => {
  test("every rule shows its version, and the badge opens its history", async ({
    page,
  }) => {
    await page.goto("/decision-rules");

    const badges = page.getByRole("button", {
      name: /view change history/i,
    });
    await expect(badges.first()).toBeVisible();

    // Every rule carries one, including unedited ones. A badge that
    // appeared only on edited rules would read as a warning.
    const rows = await page.getByRole("row").count();
    expect(await badges.count()).toBe(rows - 1); // minus the header row

    await badges.first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/in force/i).first()).toBeVisible();
  });

  test("the backfilled version says it is the current one", async ({
    page,
  }) => {
    /*
     * The migration wrote version 1 as CREATE with `effectiveTo` null
     * and `effectiveFrom` set to the rule's own createdAt. If the API
     * serialised those dates differently from what the panel expects,
     * this renders "Invalid Date" — which no component test can catch,
     * because it hands the component a string it chose itself.
     */
    await page.goto("/decision-rules");
    await page
      .getByRole("button", { name: /view change history/i })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Current")).toBeVisible();
    await expect(dialog.getByText(/invalid date/i)).toHaveCount(0);
    await expect(dialog.getByText(/backfilled at migration/i)).toBeVisible();
  });

  test("the conditions in the history match the ones in the table", async ({
    page,
  }) => {
    // Both come off the same rule by different routes — the list
    // endpoint and the versions endpoint. They must not disagree.
    await page.goto("/decision-rules");

    const firstRow = page.getByRole("row").nth(1);
    const conditionInTable = await firstRow
      .getByRole("listitem")
      .first()
      .textContent();

    await firstRow
      .getByRole("button", { name: /view change history/i })
      .click();

    await expect(
      page.getByRole("dialog").getByText(conditionInTable!.trim()),
    ).toBeVisible();
  });
});
