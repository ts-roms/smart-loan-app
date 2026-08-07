import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient, configureApiClient, getApiClient } from "./client";

/**
 * The single-flight refresh guard, and the thing that defeated it.
 *
 * `ApiClient.refreshing` is per-instance, so it only holds while there
 * is exactly one instance. `configureApiClient` used to build a new one
 * every call — and it is called more than once: eagerly during the
 * provider's first render, then again from its mount effect, which
 * React StrictMode runs twice in development.
 */

const opts = (baseUrl = "/api/v1") => ({
  baseUrl,
  getToken: () => "stale-access-token",
  getRefreshToken: () => "the-one-refresh-token",
});

describe("configureApiClient", () => {
  it("returns the same instance when called repeatedly", () => {
    const a = configureApiClient(opts());
    const b = configureApiClient(opts());
    const c = configureApiClient(opts());
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(getApiClient()).toBe(a);
  });

  it("still adopts the new options", () => {
    // Reuse must not mean ignoring the caller — the provider hands over
    // fresh closures over the live token refs on every call.
    configureApiClient(opts("/api/v1"));
    const client = configureApiClient(opts("/api/v2"));
    expect(
      (client as unknown as { opts: { baseUrl: string } }).opts.baseUrl,
    ).toBe("/api/v2");
  });
});

describe("refresh single-flight", () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * The regression. Two 401s racing must produce ONE /auth/refresh.
   *
   * A second call carries a refresh token the first has already
   * rotated, which is the server's definition of theft: it logs
   * REFRESH_TOKEN_REUSE_DETECTED and revokes every token the user has.
   * That fired on a brand-new account 2.4 seconds after signup.
   */
  it("fires one /auth/refresh for concurrent 401s on one instance", async () => {
    const client = new ApiClient(opts());
    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((r) => (releaseRefresh = r));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/auth/refresh")) {
          refreshCalls += 1;
          await refreshGate; // hold both callers inside the refresh
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accessToken: "new",
              refreshToken: "rotated",
              refreshTokenExpiresAt: new Date().toISOString(),
            }),
          };
        }
        return { ok: false, status: 401, text: async () => "{}" };
      }),
    );

    const both = Promise.allSettled([
      client.get("/loans"),
      client.get("/customers"),
    ]);
    // Let both requests take their 401 and reach the refresh.
    await Promise.resolve();
    await Promise.resolve();
    releaseRefresh!();
    await both;

    expect(refreshCalls).toBe(1);
  });

  /**
   * And the reason the guard was not enough on its own: two instances,
   * two slots, two refreshes with the same token. This is what the
   * reuse alarm was actually detecting.
   */
  it("two instances would each refresh — which is why there is only one", async () => {
    const a = new ApiClient(opts());
    const b = new ApiClient(opts());
    let refreshCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/auth/refresh")) {
          refreshCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accessToken: "new",
              refreshToken: "rotated",
              refreshTokenExpiresAt: new Date().toISOString(),
            }),
          };
        }
        return { ok: false, status: 401, text: async () => "{}" };
      }),
    );

    await Promise.allSettled([a.get("/loans"), b.get("/customers")]);
    // Two instances defeat the guard — the documented failure, kept as a
    // test so the fix in `configureApiClient` has something to protect.
    expect(refreshCalls).toBe(2);
  });
});

describe("fetchBlob", () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * The reason downloads moved off a hand-rolled `fetch`. Both call
   * sites read `localStorage` directly and had no 401 handling, so an
   * expired access token turned a Download button into "Server returned
   * 401" — on a page where the user had just filled in a date range.
   */
  it("refreshes and retries once when the token has expired", async () => {
    const client = new ApiClient(opts());
    const calls: string[] = [];
    let served = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith("/auth/refresh")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accessToken: "fresh",
              refreshToken: "rotated",
              refreshTokenExpiresAt: new Date().toISOString(),
            }),
          };
        }
        served += 1;
        if (served === 1)
          return { ok: false, status: 401, text: async () => "{}" };
        return { ok: true, status: 200, blob: async () => "csv-bytes" };
      }),
    );

    const blob = await client.fetchBlob("/reports/ecl-movement?format=csv");
    expect(blob).toBe("csv-bytes");
    expect(calls.filter((c) => c.includes("/auth/refresh"))).toHaveLength(1);
    // Original, refresh, retry — and no second refresh.
    expect(calls).toHaveLength(3);
  });

  it("gives up rather than looping when the refresh fails", async () => {
    const client = new ApiClient(opts());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/auth/refresh")
          ? { ok: false, status: 401, text: async () => "{}" }
          : { ok: false, status: 401, text: async () => "{}" },
      ),
    );
    await expect(
      client.fetchBlob("/reports/ecl-movement?format=csv"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("surfaces the server's message, not just the status", async () => {
    // A 403 on a report the user cannot run should say so.
    const client = new ApiClient(opts());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: "Missing reports.read" }),
      })),
    );
    await expect(client.fetchBlob("/reports/x")).rejects.toThrow(
      "Missing reports.read",
    );
  });
});
