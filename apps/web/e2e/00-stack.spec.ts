import { expect, test } from "@playwright/test";

import { API } from "./support";

/**
 * Prerequisites, checked first and named individually.
 *
 * Without this, a stack that is half up produces six failures in six
 * unrelated journeys, and whoever reads them starts debugging the
 * decision-rule page. Each check below fails with a sentence saying
 * which service is missing and how to start it.
 */

test.describe("the stack is up", () => {
  test("the API answers", async ({ request }) => {
    const res = await request.get(`${API}/health`).catch(() => null);

    expect(res, `No API on ${API}. Start it with: pnpm dev`).not.toBeNull();
    expect(res!.status(), `API on ${API} is unhealthy`).toBe(200);
    await expect(res!.json()).resolves.toMatchObject({ ok: true });
  });

  test("the database is seeded", async ({ request }) => {
    /*
     * A 401 here is the right answer and proves the route is mounted.
     * The failure this catches is a 500 — the API running against a
     * database with no migrations, which otherwise surfaces as a login
     * that hangs.
     */
    const res = await request.get(`${API}/customers`);

    expect(
      res.status(),
      "Expected 401 from an unauthenticated request. A 500 means the " +
        "database is unmigrated — run: pnpm dev:up",
    ).toBe(401);
  });

  test("the web app is served", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/SmartLoan/i);
  });
});
