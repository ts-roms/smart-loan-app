import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Vitest's `globals` are off in this workspace, so jest-dom is pulled in
 * via its `/vitest` entrypoint — that variant registers the matchers on
 * the `expect` Vitest exports rather than on a global.
 *
 * The explicit cleanup matters for the same reason: without `globals`,
 * @testing-library/react cannot auto-register its afterEach hook, so
 * mounted trees would leak into the next test and duplicate every query
 * result.
 */
afterEach(() => {
  cleanup();
});
