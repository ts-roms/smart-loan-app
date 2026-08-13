import { defineConfig } from "vitest/config";

/**
 * Node environment, no jsdom. The only tests here are over a pure
 * helper in src/lib — see src/lib/site.test.ts for why there are no
 * component tests.
 *
 * `dist/` is excluded explicitly: the standalone build copies the app's
 * own source tree into `dist/standalone`, and without this vitest
 * collects the copy as a second suite and reports every test twice.
 * (`dist` rather than `.next` — see `distDir` in next.config.mjs.)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
