import { defineConfig } from "vitest/config";

/**
 * This project exists to cap `maxWorkers`, and only that.
 *
 * With 32 spec files it is the largest fan-out source in the workspace,
 * and vitest's default of `availableParallelism() - 1` had it asking for
 * fifteen forks. It is also fast (~5s), so those forks spend most of
 * their life competing with `@loan/api` and `@loan/web` — which nx
 * schedules alongside it — rather than doing work. Starving the long
 * suites to start a fork that exits four seconds later is a bad trade,
 * and it is how a 5s default testTimeout gets missed two projects away.
 *
 * See apps/api/vitest.config.ts for the measurement behind the number.
 */
export default defineConfig({
  test: {
    maxWorkers: 4,
  },
});
