import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { ACCOUNTS, money, type Role } from "../support";

/**
 * The WRITE journey: apply → approve → disburse → pay, through the UI,
 * against a disposable database.
 *
 * Run it with:
 *
 *   pnpm --filter @loan/web e2e:write
 *
 * which is `e2e/write-journey/run.mjs`: it creates
 * `smart_loan_e2e_<timestamp>` on the dev Postgres, migrates + seeds
 * it, boots a dedicated API (:3003) and web server (:5183) against it,
 * runs this spec, and drops everything — also on failure. Under a bare
 * `playwright test` this file skips: the scratch stack it needs does
 * not exist, and failing six ways would only obscure that sentence.
 *
 * ── What goes through the UI, and what doesn't ──────────────────────
 *
 * Every lifecycle step is driven through the real pages:
 *
 *   • apply       — the 5-step wizard at /loans/new, as the OFFICER
 *   • approve #1  — the approval chain's "Loan officer review" step on
 *                   the loan detail page, as the OFFICER (who holds
 *                   `loans.approve.officer`)
 *   • approve #2  — "Branch manager sign-off", as the ADMIN — the only
 *                   seeded role holding `loans.approve.bm`. Two sign-ins
 *                   because the chain requires two signatures; that is
 *                   the feature, not a workaround.
 *   • disburse    — "Disburse funds" on the detail page, as the ADMIN
 *   • pay         — the "Record payment" form on the detail page, as
 *                   the ADMIN (who holds `payments.record`)
 *
 * Nothing is done over the API. The one out-of-band step is the CLOSING
 * ASSERTION: `runReconciliation` (the nightly job's five checks) is run
 * directly against the scratch database, because "the UI said so" is
 * not evidence about the ledger — the books agreeing with themselves is.
 *
 * ── Data ────────────────────────────────────────────────────────────
 *
 * Borrower: PICKER-001 "Clara Clean" (smoke-test fixtures — no live
 * loan, so the one-live-loan gate stays quiet), with a VERIFIED base
 * KYC pack seeded by `seed-kyc.ts` (the fixtures set kycStatus but the
 * wizard judges submissions). Product: SALARY — no collateral, no
 * extra KYC docs, no declarations questionnaire, so the wizard's gates
 * are satisfied by real data rather than overrides.
 *
 * ── Findings, in passing ────────────────────────────────────────────
 *
 * 1. The single-shot decide endpoint re-validates KYC and declarations
 *    before approving (`LoanWorkflowService.decide`), but the chain
 *    path — `LoanApprovalRepository.approveStep`, which is what this
 *    journey and the UI use — flips the loan to APPROVED on the final
 *    signature with no KYC/declarations re-check at all. With chains
 *    now seeded onto every product, the chain path is the common one,
 *    so those gates are effectively advisory. Reported, not fixed
 *    here; this journey's borrower passes KYC legitimately either way.
 *
 * 2. The record-payment amount input (LoanDetailPage) is a number
 *    input with the default step of 1, so native validation rejects
 *    centavo amounts — ₱4,727.98, the exact figure the ledger asks
 *    for, cannot be tendered. The journey pays the rounded-up peso
 *    and says so where it does it.
 */

const DB_URL = process.env.E2E_WRITE_DB_URL ?? "";
// ESM spec (apps/web is "type": "module") — no __dirname here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS_DB = path.resolve(HERE, "../../../../libs/db");

/** Sign in through the real form — same reasoning as e2e/support.ts. */
async function signIn(page: Page, role: Role) {
  const { email, password } = ACCOUNTS[role];
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Enter password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Generous: the scratch Vite is cold, and the first authenticated
  // render transforms most of the app graph.
  await expect(page.getByRole("link", { name: "Customers" })).toBeVisible({
    timeout: 60_000,
  });
}

/** The amortization ledger's totals row: "Paid to date" / "Outstanding". */
function ledgerTotal(page: Page, label: string) {
  return page.locator(`dt:has-text("${label}") + dd`).first();
}

/** The ledger table, anchored by a header no other table has. */
function ledgerTable(page: Page) {
  return page.locator("table").filter({ hasText: "Scheduled bal." });
}

test.describe("write journey: apply → approve → disburse → pay", () => {
  test.skip(
    !DB_URL,
    "Needs the disposable scratch stack — run via: pnpm --filter @loan/web e2e:write",
  );

  test("the full lifecycle, and the books still reconcile", async ({
    browser,
  }) => {
    // The guard restated where the writes happen: this spec must only
    // ever run against a database the runner is about to drop.
    expect(
      DB_URL,
      "E2E_WRITE_DB_URL must name a smart_loan_e2e_<timestamp> database",
    ).toMatch(/\/smart_loan_e2e_\d+(\?|$)/);

    let loanNumber = "";
    let installmentTotal = 0;
    let outstandingBefore = 0;

    // ── Officer: apply through the wizard ─────────────────────────
    const officerCtx = await browser.newContext();
    const officer = await officerCtx.newPage();
    await test.step("officer applies via the 5-step wizard", async () => {
      await signIn(officer, "officer");
      await officer.goto("/loans/new");

      // Step 1 — borrower. Typeahead; suggestions are role=option.
      await officer
        .getByPlaceholder("Search by name or reference")
        .fill("Clara");
      await officer.getByRole("option", { name: /Clara Clean/ }).click();
      await officer
        .getByRole("button", { name: "Next · Product & Terms" })
        .click();

      // Step 2 — product & terms. Defaults (₱50,000 / 12 months / 24%)
      // are within SALARY's ranges; the KYC checklist must read ready,
      // which it does because seed-kyc.ts verified the base pack.
      await officer.getByLabel("Loan product").click();
      await officer.getByRole("option", { name: "Salary Loan" }).click();
      await expect(officer.getByText("Ready to apply")).toBeVisible({
        timeout: 20_000,
      });
      await officer
        .getByRole("button", { name: "Next · Collateral & Co-makers" })
        .click();

      // Step 3 — SALARY is unsecured; nothing to fill.
      await expect(
        officer.getByText("This product has no collateral requirement"),
      ).toBeVisible();
      await officer
        .getByRole("button", { name: "Next · Verification" })
        .click();

      // Step 4 — selfie and purpose are optional.
      await officer.getByRole("button", { name: "Next · Review" }).click();

      // Step 5 — submit. Lands on the loan's detail page at its LN- URL.
      await officer.getByRole("button", { name: "Submit application" }).click();
      await officer.waitForURL(/\/loans\/LN-[0-9-]+$/, { timeout: 30_000 });
      loanNumber = officer.url().split("/").pop()!;
      await expect(officer.getByText("SUBMITTED").first()).toBeVisible();
    });

    await test.step("officer signs the chain's first step", async () => {
      // The chain panel: step 1 "Loan officer review" is current and the
      // officer holds its permission, so the row offers Approve. The
      // legacy single-shot Approve button is absent while the chain is
      // pending — the page says so in words. `exact` because that very
      // message repeats the step labels ("1. Loan officer review, 2. …").
      await expect(
        officer.getByText("Loan officer review", { exact: true }),
      ).toBeVisible();
      await officer
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      await officer.getByRole("button", { name: "Approve step" }).click();
      /*
       * `exact` on every toast assertion in this spec, and it is not
       * cosmetic: each toast is announced twice, once in the visible
       * div and once in an aria-live region that prefixes it with
       * "Notification ". A substring match therefore resolves two
       * nodes and fails on strict mode — intermittently, because it
       * depends on whether the announcement has landed yet.
       */
      await expect(
        officer.getByText("Step 1 approved.", { exact: true }),
      ).toBeVisible();
      // Step 2 is now current — and explicitly not the officer's to sign.
      await expect(
        officer.getByText("You don't hold the required permission"),
      ).toBeVisible();
    });
    await officerCtx.close();

    // ── Admin: second signature, disburse, pay ────────────────────
    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    await test.step("admin signs the branch-manager step", async () => {
      await signIn(admin, "admin");
      await admin.goto(`/loans/${loanNumber}`);
      await expect(
        admin.getByText("Branch manager sign-off", { exact: true }),
      ).toBeVisible();
      await admin.getByRole("button", { name: "Approve", exact: true }).click();
      await admin.getByRole("button", { name: "Approve step" }).click();
      await expect(
        admin.getByText("Step 2 approved.", { exact: true }),
      ).toBeVisible();
      // Final signature flips the loan to APPROVED.
      await admin.reload();
      await expect(admin.getByText("APPROVED").first()).toBeVisible();
    });

    await test.step("admin disburses", async () => {
      await admin.getByRole("button", { name: "Disburse funds" }).click();
      await expect(
        admin.getByText("Loan disbursed", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      // Disbursement lands the loan on ACTIVE with a 12-row schedule.
      await admin.reload();
      await expect(admin.getByText("ACTIVE").first()).toBeVisible();
      await expect(admin.getByText("Amortization ledger (12)")).toBeVisible();

      // Read the first installment's total and the outstanding balance
      // off the screen — the journey pays what the ledger asks, not a
      // number recomputed in the test.
      const firstRow = ledgerTable(admin).locator("tbody tr").first();
      installmentTotal = money(
        await firstRow.locator("td").nth(4).textContent(),
      );
      expect(installmentTotal).toBeGreaterThan(0);
      outstandingBefore = money(
        await ledgerTotal(admin, "Outstanding").textContent(),
      );
      expect(outstandingBefore).toBeGreaterThan(0);
    });

    await test.step("admin records the first installment's payment", async () => {
      /*
       * Scoped to the record-payment form: the Collections panel's
       * "Promises to pay" section has its own placeholder="Amount"
       * input, so the bare getByPlaceholder is ambiguous on this page.
       *
       * The amount is the CEILING of the installment total, not the
       * exact figure, and that is a finding, not a preference: the
       * form's amount input is type="number" with the default step of
       * 1, so the browser's native validation rejects "4727.98" — the
       * UI cannot tender the centavos its own ledger asks for. An
       * operator would hit the same wall. Rounding up keeps the first
       * installment fully settled; the spare centavos allocate into
       * installment 2, which the closeTo assertions below absorb.
       */
      const payForm = admin
        .locator("form")
        .filter({ has: admin.getByPlaceholder("Reference / OR #") });
      const amountPaid = Math.ceil(installmentTotal);
      await payForm.getByPlaceholder("Amount").fill(String(amountPaid));
      await payForm.getByPlaceholder("Reference / OR #").fill("E2E-OR-0001");
      await payForm
        .getByRole("button", { name: "Record", exact: true })
        .click();
      await expect(
        admin.getByText("Payment recorded", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });

      // The balance moved, on screen: installment 1 reads Paid, paid-to-
      // date equals what was tendered (within the rounded-up centavos),
      // and outstanding fell by the same.
      await admin.reload();
      await expect(admin.getByText("ACTIVE").first()).toBeVisible();
      const firstRow = ledgerTable(admin).locator("tbody tr").first();
      await expect(firstRow.getByText("Paid", { exact: true })).toBeVisible();
      const paidToDate = money(
        await ledgerTotal(admin, "Paid to date").textContent(),
      );
      expect(paidToDate).toBeCloseTo(Math.ceil(installmentTotal), 1);
      const outstandingAfter = money(
        await ledgerTotal(admin, "Outstanding").textContent(),
      );
      expect(outstandingAfter).toBeCloseTo(
        outstandingBefore - Math.ceil(installmentTotal),
        1,
      );
    });
    await adminCtx.close();

    // ── The closing argument: the scratch ledger reconciles ───────
    await test.step("all five reconciliation checks pass", async () => {
      const script = path.join(HERE, "scripts", "reconcile-check.mjs");
      const res = spawnSync(`pnpm exec tsx "${script}"`, {
        cwd: LIBS_DB,
        env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production" },
        shell: true,
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = (res.stdout ?? "")
        .split("\n")
        .find((l) => l.startsWith("RECONCILIATION_JSON:"));
      expect(
        line,
        `reconcile-check produced no result.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      ).toBeTruthy();
      const result = JSON.parse(line!.slice("RECONCILIATION_JSON:".length)) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; summary: string }>;
      };
      expect(result.checks).toHaveLength(5);
      expect(
        result.ok,
        result.checks
          .map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.summary}`)
          .join("\n"),
      ).toBe(true);
    });
  });
});
