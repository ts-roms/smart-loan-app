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
 * jsdom rather than node because the component specs assert on real
 * accessible-name computation (see field.test.tsx): the label/control
 * association only exists once there is a DOM to associate in.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
