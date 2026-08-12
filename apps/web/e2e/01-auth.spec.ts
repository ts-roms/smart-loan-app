import { expect, test } from "@playwright/test";

import { ACCOUNTS, expectSignedOut, signIn } from "./support";

/*
 * The one spec that opts OUT of the saved session. Everywhere else
 * reuses it, because the login route is throttled and a suite that
 * signed in per test tripped the limit — but here the login screen is
 * the subject, not the means.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Journey 1 — getting in, and being kept out.
 *
 * The one screen every user meets. It is also the only journey whose
 * failure makes the other five meaningless, which is why it runs first
 * and why the helper the others use drives this form rather than
 * writing a token into localStorage.
 */

test.describe("signing in", () => {
  test("lands an admin in the app", async ({ page }) => {
    await signIn(page, "admin");

    await expect(
      page.getByRole("link", { name: "Decision rules" }),
    ).toBeVisible();
  });

  test("refuses a wrong password without saying which field was wrong", async ({
    page,
  }) => {
    /*
     * "No account with that email" tells an attacker which addresses
     * are worth attacking. The message must not distinguish a bad
     * password from a missing account.
     */
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(ACCOUNTS.admin.email);
    await page.getByPlaceholder("Enter password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText(/invalid/i)).toBeVisible();
    await expectSignedOut(page);
  });

  test("bounces an unauthenticated visitor off a protected route", async ({
    page,
  }) => {
    // Deep-linking into the app with no session must not render a shell
    // full of empty panels — it must ask for a sign-in.
    await page.goto("/decision-rules");

    await expectSignedOut(page);
  });
});

test.describe("signing out", () => {
  test("ends the session, and the back button does not restore it", async ({
    page,
  }) => {
    /*
     * The failure this catches: a sign-out that clears React state but
     * leaves the token in localStorage. The app looks signed out until
     * someone presses Back, and then does not.
     */
    await signIn(page, "admin");

    await page.getByRole("button", { name: /profile menu/i }).click();
    await page.getByRole("menuitem", { name: /log out/i }).click();
    await expectSignedOut(page);

    await page.goBack();
    await expectSignedOut(page);

    const token = await page.evaluate(() =>
      localStorage.getItem("loan.auth.token"),
    );
    expect(token).toBeNull();
  });
});
