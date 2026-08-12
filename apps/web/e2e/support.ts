import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers. Deliberately thin — an E2E suite that grows a page
 * object per screen ends up testing the page objects.
 */

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:3001/api/v1";

/** The development seed's accounts. `libs/db/prisma/seed.ts`. */
export const ACCOUNTS = {
  admin: { email: "admin@loan.local", password: "P@ssw0rd123" },
  officer: { email: "officer@loan.local", password: "P@ssw0rd123" },
  collector: { email: "collector@loan.local", password: "P@ssw0rd123" },
} as const;

export type Role = keyof typeof ACCOUNTS;

/**
 * Where each role's saved session lives.
 *
 * Gitignored — these hold real (development) tokens, and a token in the
 * repository is a token in every fork.
 */
export const STATE: Record<Role, string> = {
  admin: "e2e/.auth/admin.json",
  officer: "e2e/.auth/officer.json",
  collector: "e2e/.auth/collector.json",
};

/**
 * Sign in through the actual form.
 *
 * Not by writing the token into localStorage directly, even though that
 * would be faster and is the usual advice. The login form is the one
 * screen every user meets, and seeding around it would leave the suite
 * unable to notice if it broke — which is the precise shape of test
 * that reports green through an outage.
 */
export async function signIn(page: Page, role: Role) {
  const { email, password } = ACCOUNTS[role];
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Enter password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The shell's nav is the first thing that only exists once
  // authenticated, so it is the honest signal that sign-in landed.
  await expect(page.getByRole("link", { name: "Customers" })).toBeVisible();
}

/** Is the app showing the signed-out screen? */
export async function expectSignedOut(page: Page) {
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

/**
 * Peel the peso formatting off a cell so a test can compare numbers.
 * "₱1,234.56" → 1234.56. Returns NaN for anything that is not money,
 * which fails an assertion more usefully than 0 would.
 */
export function money(text: string | null): number {
  if (!text) return NaN;
  const cleaned = text.replace(/[^0-9.-]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}
