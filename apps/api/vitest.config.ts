import { defineConfig } from "vitest/config";

/**
 * The API suite had no config at all, which meant it ran on two vitest
 * defaults that are wrong for a workspace this size.
 *
 * ## maxWorkers
 *
 * Vitest defaults to `os.availableParallelism() - 1` forks — fifteen on
 * a sixteen-core machine. `nx run-many -t test` runs three projects at a
 * time, so `@loan/api`, `@loan/db` and `@loan/web` between them asked
 * for up to forty-five forked processes on sixteen cores. Every one of
 * them re-pays the full transform and import cost, so the fan-out was
 * not even buying speed: measured cold on this suite, fifteen workers
 * took 87s and four took 65s. Capping is faster in isolation AND leaves
 * headroom for the other projects — there is no trade here.
 *
 * ## testTimeout
 *
 * The default is 5s, and under that oversubscription two different
 * projects were observed failing with `Test timed out in 5000ms` on
 * test bodies that do nothing but read files — openapi.coverage's
 * `countSources()` walks ~50 route modules off disk. Five seconds of
 * wall clock for that is starvation, not slowness: the assertion
 * (a count of documented operations) has no timing semantics at all, so
 * a run that misses the budget is reporting on the machine rather than
 * on the code. 15s, matching apps/web, which reached the same
 * conclusion for the same reason.
 *
 * Note this raises a BUDGET, not a tolerance — no assertion anywhere is
 * loosened. A test that genuinely hangs still fails, three times slower.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    /**
     * Pins UPLOADS_DIR to a per-file temp directory so nothing in the
     * suite can write into `apps/api/uploads/`. See the file itself.
     */
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15_000,
    maxWorkers: 4,
  },
});
