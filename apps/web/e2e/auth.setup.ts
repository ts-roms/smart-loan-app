import { test as setup } from "@playwright/test";

import { signIn, STATE, type Role } from "./support";

/**
 * Sign in once per role and save the session for every other spec.
 *
 * Not an optimisation — a correctness fix. The login route is throttled
 * at 10 attempts a minute (`auth.routes.ts`), which is the right
 * setting and which a suite that signed in per test walked straight
 * into: eleven journeys in ninety seconds, and the twelfth got
 * "Rate limit exceeded" instead of a dashboard.
 *
 * The failure was in the SUITE, not the app. Raising the limit to suit
 * the tests would have been the wrong repair — it would weaken a real
 * control to accommodate a habit no user has.
 *
 * `01-auth.spec.ts` deliberately opts out and drives the form itself.
 * That is the one place the login screen is the subject rather than the
 * means, and seeding around it there would leave the suite unable to
 * notice if it broke.
 */

const ROLES: Role[] = ["admin", "collector"];

for (const role of ROLES) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await signIn(page, role);
    await page.context().storageState({ path: STATE[role] });
  });
}
