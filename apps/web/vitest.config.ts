import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: that file loads the PWA
 * plugin and a build-time HTML rewriter, neither of which a unit test
 * run needs, and both of which slow it down for nothing.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
