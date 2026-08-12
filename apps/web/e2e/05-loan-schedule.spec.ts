import { expect, test } from "@playwright/test";

import { money, STATE } from "./support";

/**
 * Journey 5 — the numbers on screen are the numbers in the ledger.
 *
 * This is the only journey where being wrong costs money rather than
 * confidence. Everything upstream of the screen is heavily tested —
 * `golden-corpus.test.ts` pins 49 amortisation values, the accounting
 * invariants pin 26 more, and a nightly job reconciles the subledger to
 * the GL. None of that says anything about the render. A schedule that
 * computes correctly and displays a column shifted by one is a schedule
 * an officer will read out to a borrower.
 *
 * So the assertions are arithmetic performed on what the DOM actually
 * shows, not on what an API returned.
 *
 * Read-only, like the rest: it opens an existing disbursed fixture loan
 * and checks its own rows against each other.
 */

test.use({ storageState: STATE.admin });

test.describe("a disbursed loan's schedule", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/loans");
    await expect(page.getByRole("table").first()).toBeVisible();
  });

  test("the instalment rows add up, row by row", async ({ page }) => {
    /*
     * Principal + Interest = Total on every line. A column that has
     * slipped shows up here immediately, and it is the single cheapest
     * assertion that the table is wired to the right fields.
     */
    await openFirstLoanWithASchedule(page);

    const rows = scheduleRows(page);
    const count = await rows.count();
    expect(count, "the fixture loan has no schedule rows").toBeGreaterThan(0);

    for (let i = 0; i < Math.min(count, 6); i++) {
      const cells = rows.nth(i).locator("td");
      const principal = money(await cells.nth(2).textContent());
      const interest = money(await cells.nth(3).textContent());
      const total = money(await cells.nth(4).textContent());

      expect(
        Math.abs(principal + interest - total),
        `row ${i + 1}: ${principal} + ${interest} != ${total}`,
      ).toBeLessThanOrEqual(0.01);
    }
  });

  test("the scheduled balance falls by exactly that row's principal", async ({
    page,
  }) => {
    /*
     * The running balance was added as its own column precisely because
     * an officer reads it aloud. If it were recomputed from a rounded
     * display value rather than carried, the drift would accumulate
     * down the page — and it would look plausible the whole way.
     */
    await openFirstLoanWithASchedule(page);

    const rows = scheduleRows(page);
    const count = Math.min(await rows.count(), 6);
    expect(count).toBeGreaterThan(1);

    let previous: number | null = null;
    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator("td");
      const principal = money(await cells.nth(2).textContent());
      const balance = money(await cells.nth(6).textContent());

      if (previous !== null) {
        expect(
          Math.abs(previous - principal - balance),
          `row ${i + 1}: balance fell by ${previous - balance}, principal was ${principal}`,
        ).toBeLessThanOrEqual(0.01);
      }
      previous = balance;
    }
  });

  test("the last row clears the loan", async ({ page }) => {
    /*
     * The schedule's final principal is trued up so the rounded parts
     * sum exactly to the amount lent. A balance that ends at a few
     * centavos is the classic symptom of that true-up being dropped,
     * and it is invisible on any single row.
     */
    await openFirstLoanWithASchedule(page);

    const rows = scheduleRows(page);
    const last = rows.last();
    const balance = money(await last.locator("td").nth(6).textContent());

    expect(
      Math.abs(balance),
      "the schedule does not end at zero",
    ).toBeLessThanOrEqual(0.01);
  });
});

/**
 * The instalment rows, and only those.
 *
 * A loan's detail page carries several tables — payments, approvals,
 * co-makers. `table tbody tr` sweeps all of them, and the earlier
 * version of this file got away with it only because it never looked
 * past row six. Asking for the table that has the "Scheduled bal."
 * header is both narrower and self-documenting: if that column is ever
 * renamed, this fails saying so rather than silently measuring a
 * different table.
 */
function scheduleRows(page: import("@playwright/test").Page) {
  return page
    .locator("table")
    .filter({ has: page.getByRole("columnheader", { name: /scheduled bal/i }) })
    .locator("tbody tr");
}

/**
 * Open a loan far enough along to have a schedule.
 *
 * Two traps, both hit on the way to this version.
 *
 * The fixtures cover the whole lifecycle, so the first row in the list
 * is as likely to be a SUBMITTED application — which has no schedule at
 * all — as a disbursed one. Hence picking by status.
 *
 * And the row's first LINK is the borrower's name, not the loan: the
 * number cell is a quick-view drawer trigger, deliberately, so an
 * officer scanning the book can peek without losing their place.
 * Following it lands on the customer. So this reads the number and
 * navigates, rather than clicking whatever link comes first.
 */
async function openFirstLoanWithASchedule(
  page: import("@playwright/test").Page,
) {
  const active = page
    .getByRole("row")
    .filter({ hasText: /ACTIVE|DISBURSED/ })
    .first();
  await expect(
    active,
    "no ACTIVE or DISBURSED loan in the fixtures — reseed them with " +
      "docs/smoke-tests/e2e.sh",
  ).toBeVisible();

  const number = (
    await active.getByRole("button", { name: /quick-view loan/i }).textContent()
  )?.trim();
  expect(number, "could not read a loan number off the row").toBeTruthy();

  await page.goto(`/loans/${number}`);
  await expect(page.getByText(/scheduled bal/i)).toBeVisible();
}
