import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: that file loads the PWA
 * plugin and a build-time HTML rewriter, neither of which a unit test
 * run needs, and both of which slow it down for nothing.
 *
 * jsdom rather than node because the tests worth writing here are
 * component tests. The web app has almost no pure helpers — its logic
 * lives in what it decides to RENDER, which is exactly where the risk
 * is: a control that should be hidden and isn't.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Each file gets a clean DOM; testing-library's auto-cleanup runs
    // between tests within one.
    restoreMocks: true,
  },
});
