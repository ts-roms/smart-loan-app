import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against the real stack.
 *
 * The component suites under `src/**` prove a page renders what it
 * should FROM GIVEN DATA — they mock `@loan/api-client`, so by
 * construction they cannot catch the failure mode that actually bites:
 * the API and the page disagreeing about a shape. A field renamed on
 * the server passes every component test and shows a blank column in
 * production. That gap is what these journeys close, and it is why they
 * run against a live API rather than a fixture server.
 *
 * The consequence is a real prerequisite — database, migrations, seed,
 * licence, API, web — documented in `e2e/README.md` and asserted by the
 * first spec so a missing one reads as "the stack is not up" rather
 * than as six mysterious failures.
 *
 * `reuseExistingServer` is on for local runs: the dev servers are
 * usually already up, and starting a second Vite on a taken port is a
 * worse failure than reusing the first.
 */

/*
 * `localhost` here and 127.0.0.1 for the API in `e2e/support.ts`, which
 * looks inconsistent and is not.
 *
 * Vite's dev server binds `::1` only, so 127.0.0.1:5173 refuses the
 * connection outright — a confusing failure to hand someone on their
 * first run. The API is the opposite case: it listens on both, and
 * `localhost` there is the exact trap this repo already fell into, when
 * another project's server on `[::]:3001` answered every call with a
 * truthful 404 (`4cf5a0b`). So each is pinned to whichever form is
 * unambiguous for that service.
 */
const WEB = process.env.E2E_WEB_URL ?? "http://localhost:5173";

/*
 * Is the write journey being asked for?
 *
 * It is defined as a project only when it is, so that a bare
 * `playwright test` does not merely SKIP it — it never selects it, and
 * the read suite's result stays exactly the count it was before this
 * project existed. The two ways of asking:
 *
 *   • `e2e/write-journey/scripts/run.mjs` exports E2E_WRITE_DB_URL when
 *     it invokes Playwright — it is the only thing that can, since the
 *     value names the scratch database it just created.
 *   • `--project=write-journey` typed by hand, which is worth keeping
 *     working: the spec's own skip then explains that the journey needs
 *     the runner, which is a better answer than Playwright's "project
 *     not found".
 */
const WRITE_JOURNEY_REQUESTED =
  Boolean(process.env.E2E_WRITE_DB_URL) ||
  process.argv.includes("write-journey") ||
  process.argv.includes("--project=write-journey");

export default defineConfig({
  testDir: "./e2e",
  /*
   * Serial. These journeys read a shared development database, and the
   * one thing worse than a slow suite is a flaky one that fails because
   * two workers logged the same user in and out of each other's
   * sessions.
   */
  workers: 1,
  fullyParallel: false,
  /*
   * No retries locally — a test that passes on the second attempt is a
   * test telling you something, and swallowing it here is how a suite
   * stops being believed. CI gets one, for genuine network flake.
   */
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    /*
     * Signs in once per role and saves the session. Everything else
     * depends on it, because the login route is throttled at 10 a
     * minute and a suite that signed in per test tripped it — see
     * `auth.setup.ts`.
     */
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      /*
       * The write journey is not part of this suite: it runs against a
       * disposable scratch stack, not the dev stack these journeys
       * read. Ignored here so `playwright test` keeps meaning exactly
       * what it meant before the write project existed.
       */
      testIgnore: /write-journey/,
    },
    /*
     * The WRITE journey — apply → approve → disburse → pay against a
     * disposable database. Selected only by its runner:
     *
     *   pnpm --filter @loan/web e2e:write
     *
     * which creates smart_loan_e2e_<timestamp>, boots a dedicated API
     * (:3003) + web (:5183) against it, runs this project, and drops
     * the database afterwards — also on failure. It is not even
     * DEFINED unless asked for (see WRITE_JOURNEY_REQUESTED above), so
     * a plain `playwright test` runs the same tests it always did —
     * not "the same plus one skip".
     *
     * No dependency on "setup": those storage states hold dev-stack
     * tokens for dev-stack user ids. The journey signs into its own
     * scratch stack — two sign-ins per run, nowhere near the login
     * route's 10/minute throttle on a fresh API instance.
     */
    ...(WRITE_JOURNEY_REQUESTED
      ? [
          {
            name: "write-journey",
            testMatch: /write-journey\/.*\.spec\.ts/,
            // One journey, five lifecycle stages, a cold Vite. The
            // global 30s is right for reads; it is not right for this.
            timeout: 300_000,
            use: {
              ...devices["Desktop Chrome"],
              baseURL: process.env.E2E_WRITE_WEB_URL ?? "http://localhost:5183",
              navigationTimeout: 90_000,
            },
          },
        ]
      : []),
  ],
});
