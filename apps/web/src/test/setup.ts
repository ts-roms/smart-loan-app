import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Shared setup for component tests.
 *
 * Vitest's `globals` are off in this workspace, so jest-dom is pulled in
 * via its `/vitest` entrypoint — that variant registers the matchers on
 * the `expect` Vitest exports rather than on a global. The explicit
 * cleanup matters for the same reason: without `globals`,
 * @testing-library/react cannot auto-register its afterEach hook, so
 * mounted trees would leak into the next test and duplicate every query
 * result.
 *
 * jsdom implements the DOM but not the browser around it. Everything
 * stubbed below is something jsdom genuinely does not have — not
 * something the app should be avoiding. A stub that hides real
 * behaviour would make these tests worse than none.
 */

afterEach(cleanup);

/** Radix primitives measure with this; jsdom has no layout engine. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Radix Select/Dialog check it before trapping focus. */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/** Used for scroll-into-view on menu open. */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(this: void) {};
}

/** Theme queries read this at mount. */
globalThis.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

/*
 * Fail a test that reaches the network.
 *
 * A component test that quietly falls through to fetch is testing the
 * absence of a response, not the component — and it passes for the
 * wrong reason. Anything that needs data mocks its hook explicitly.
 */
globalThis.fetch = vi.fn<typeof fetch>(() => {
  throw new Error(
    "A component test tried to fetch(). Mock the hook it calls instead.",
  );
});
