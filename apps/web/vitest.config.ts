import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: that file loads the PWA
 * plugin and a build-time HTML rewriter, neither of which a unit test
 * run needs, and both of which slow it down for nothing.
 *
 * The React plugin IS needed here — component specs are .tsx and would
 * otherwise reach the runner untransformed.
 *
 * jsdom rather than node because the tests worth writing here are
 * component tests. The web app has almost no pure helpers — its logic
 * lives in what it decides to RENDER, which is exactly where the risk
 * is: a control that should be hidden and isn't. The specs also assert
 * on real accessible-name computation (see field.test.tsx), and the
 * label/control association only exists once there is a DOM to
 * associate in.
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
    /*
     * Three times the default, because these tests are three times the
     * work: mounting a page, rendering Radix menus and dialogs into
     * jsdom, and driving them with userEvent's real-ish event sequences.
     *
     * They pass comfortably on their own and were seen to time out under
     * `nx run-many -t test`, where fourteen projects compete for the
     * same cores. A suite that fails on a busy machine and passes on a
     * quiet one is a suite people learn to re-run instead of read.
     */
    testTimeout: 15_000,
  },
});
