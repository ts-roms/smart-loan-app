import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loaded, loading, queryHook } from "../test/render";

/**
 * Invariant: this hook fails CLOSED.
 *
 * It is the single gate behind every hidden control in the app —
 * "Apply for a loan", "Sign out everywhere", "Retire rule", the archive
 * item. It is four lines long, which is exactly why it is worth a test:
 * the `?? false` at the end is the kind of thing a refactor flips to
 * `?? true` while making the types nicer, and nothing else in the
 * codebase would notice.
 *
 * The loading case is the one that matters. An optimistic default would
 * flash admin-only controls at every user on every page load, and fire
 * the requests behind them, which then 403. Answering "no" until the
 * list arrives costs one render of a hidden button.
 *
 * This is not the security boundary — the API is, and it checks the
 * same RBAC tables. This is what stops the UI from offering something
 * the API will refuse.
 */

const useMyPermissions = queryHook();

vi.mock("@loan/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyPermissions,
}));

async function ask(key: string) {
  const { usePermission } = await import("./use-permission");
  return renderHook(() => usePermission(key)).result.current;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePermission", () => {
  it("grants a permission the user holds", async () => {
    useMyPermissions.mockReturnValue(
      loaded({ permissions: ["loans.apply", "admin.users"] }),
    );

    expect(await ask("loans.apply")).toBe(true);
  });

  it("refuses one they do not", async () => {
    useMyPermissions.mockReturnValue(loaded({ permissions: ["loans.read"] }));

    expect(await ask("loans.apply")).toBe(false);
  });

  it("refuses while the list is still loading", async () => {
    // The case that would flash admin UI at everyone.
    useMyPermissions.mockReturnValue(loading());

    expect(await ask("admin.users")).toBe(false);
  });

  it("refuses when the request failed", async () => {
    useMyPermissions.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("network"),
      refetch: () => {},
    });

    expect(await ask("admin.users")).toBe(false);
  });

  it("refuses when the response carries no permissions field", async () => {
    // A shape change on the API side must not read as "everything is
    // allowed".
    useMyPermissions.mockReturnValue(loaded({}));

    expect(await ask("admin.users")).toBe(false);
  });

  it("matches the key exactly, not by prefix", async () => {
    /*
     * `admin.users` must not satisfy `admin.users.delete`, and holding
     * `loans.read` must not satisfy `loans.read_all`. Substring
     * matching here would quietly widen every grant in the system.
     */
    useMyPermissions.mockReturnValue(loaded({ permissions: ["admin.users"] }));

    expect(await ask("admin.users.delete")).toBe(false);
    expect(await ask("admin")).toBe(false);
  });
});
