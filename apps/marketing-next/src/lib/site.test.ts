import { describe, expect, it } from "vitest";

import { slugify } from "./site";

/**
 * The Vite marketing app had no tests at all. These are not a
 * regression net for the migration — a slug helper is not what would
 * break — they exist so the new project has a real `test` target in
 * `nx run-many -t test`, and because `slugify` decides a tenant's
 * permanent workspace name and had never been checked.
 *
 * Explicitly NOT covered: any component. Rendering an App Router page
 * under vitest needs jsdom, @testing-library/react and a React 18
 * environment shim for the server/client split, none of which this
 * pilot set up. That gap is stated plainly in the report rather than
 * disguised by testing something easy.
 */
describe("slugify", () => {
  it("lowercases and hyphenates a cooperative name", () => {
    expect(slugify("Bayanihan Multi-Purpose Cooperative")).toBe(
      "bayanihan-multi-purpose-cooperative",
    );
  });

  it("collapses runs of punctuation into one hyphen", () => {
    expect(slugify("Mt. Banahaw  MPC")).toBe("mt-banahaw-mpc");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  ¡Cooperativa!  ")).toBe("cooperativa");
  });

  it("caps the slug at 40 characters", () => {
    const long = slugify("a".repeat(60));
    expect(long).toHaveLength(40);
  });

  it("truncation can leave a trailing hyphen — documented, not fixed", () => {
    /*
     * `.slice(0, 40)` runs AFTER the trim, so a name whose 41st
     * character is the separator yields a slug ending in "-". The API
     * validates against `[a-z][a-z0-9-]+` (see the input's `pattern`
     * in signup-form.tsx), which accepts it, so this is cosmetic
     * rather than broken. Asserted so that if someone reorders those
     * two operations the change is deliberate.
     */
    expect(slugify(`${"a".repeat(40)} coop`)).toBe(`${"a".repeat(40)}`);
    expect(slugify(`${"a".repeat(39)} coop`)).toBe(`${"a".repeat(39)}-`);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});
