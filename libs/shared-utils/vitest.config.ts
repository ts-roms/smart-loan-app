import { defineConfig } from "vitest/config";

/**
 * `psgc.test.ts` was caught failing with `Test timed out in 5000ms` on
 * "loads a city's barangays on demand" during a loaded parallel run.
 *
 * That test awaits `loadBarangaysForCity`, which lazily imports a
 * generated barangay table — a large module whose transform cost lands
 * inside the test body rather than at file load. It is I/O and CPU, not
 * logic, so the 5s default budget measures the machine. Nothing about
 * the assertion changes; it just gets long enough to be about the code.
 *
 * See apps/api/vitest.config.ts for the wider diagnosis.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    maxWorkers: 4,
  },
});
