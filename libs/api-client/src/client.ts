/**
 * Tiny fetch wrapper used by every TanStack Query hook in this lib.
 * Extracts the server's human `message` into `ApiError.message` so the UI
 * can render "Invalid credentials" instead of "API 401".
 *
 * Refresh-on-401: when a request comes back with HTTP 401 and the caller
 * supplied a `refreshSession` hook, the client transparently calls it
 * once, replaces the access token via `onTokenRefreshed`, and retries the
 * original request. A failed refresh hands the error back to the UI which
 * triggers logout.
 */
export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | null | undefined;
  /** Returns the current refresh token, or null if there isn't one. */
  getRefreshToken?: () => string | null | undefined;
  /**
   * Returns the tenant slug the current session belongs to. Used to
   * carry the slug along with the refresh token (Phase 2 — refresh
   * tokens live in tenant_<slug> tables; server needs to know which
   * schema to look in). In single-tenant deployments the value is
   * ignored server-side, so omitting this is fine; in multi-tenant
   * deployments returning null/undefined makes refresh fail.
   */
  getTenantSlug?: () => string | null | undefined;
  /** Called when /auth/refresh returns a new access+refresh pair. */
  onTokenRefreshed?: (next: {
    accessToken: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
  }) => void;
  /** Called when refresh fails — the client should sign the user out. */
  onRefreshFailed?: () => void;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  /** In-flight refresh promise so concurrent 401s share one /auth/refresh call. */
  private refreshing: Promise<string | null> | null = null;

  constructor(private opts: ApiClientOptions) {}

  /**
   * Point the client at new options WITHOUT replacing the instance.
   *
   * The single-flight guard above is per-instance, so it only holds if
   * there is exactly one instance. `configureApiClient` used to build a
   * fresh `ApiClient` on every call and it is called more than once —
   * eagerly during the provider's first render, then again from its
   * mount effect, which React StrictMode runs twice in development.
   *
   * Each new instance arrived with an empty `refreshing` slot while the
   * previous one still had a refresh in flight, so two `/auth/refresh`
   * calls went out carrying the SAME refresh token. The first rotated
   * it; the second presented a token already revoked, which is the
   * server's definition of theft. It logged
   * REFRESH_TOKEN_REUSE_DETECTED and revoked every token the user had —
   * on a brand-new account, 2.4 seconds after signup, for no reason
   * beyond the client having two of itself.
   */
  reconfigure(opts: ApiClientOptions): void {
    this.opts = opts;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const token = this.opts.getToken?.();
    const headers = new Headers(init.headers);
    // For FormData, let the browser set Content-Type (with the multipart boundary).
    // For anything else with a body, default to JSON.
    const isFormData =
      typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body != null && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (res.status === 401 && retry && !path.startsWith("/auth/")) {
      // Try the refresh dance — once. If it succeeds, we recurse with
      // `retry=false` so a still-401 response just propagates.
      const nextToken = await this.tryRefresh();
      if (nextToken) {
        return this.request<T>(path, init, false);
      }
    }
    if (!res.ok) {
      const text = await res.text();
      const parsed = safeParse(text);
      const message =
        parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof parsed.message === "string"
          ? (parsed as { message: string }).message
          : `API ${res.status}`;
      throw new ApiError(res.status, message, parsed);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Single-flight refresh — if multiple requests fail with 401 at once,
   * only one /auth/refresh round-trip fires; the rest await its promise.
   */
  private async tryRefresh(): Promise<string | null> {
    const refresh = this.opts.getRefreshToken?.();
    if (!refresh) return null;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          // Carry the tenant slug if the host has one. Single-tenant
          // deployments ignore the field server-side; multi-tenant
          // ones require it (refresh tokens are tenant-scoped).
          const tenantSlug = this.opts.getTenantSlug?.();
          const body: { refreshToken: string; tenantSlug?: string } = {
            refreshToken: refresh,
          };
          if (tenantSlug) body.tenantSlug = tenantSlug;
          const res = await fetch(`${this.opts.baseUrl}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            this.opts.onRefreshFailed?.();
            return null;
          }
          const data = (await res.json()) as {
            accessToken: string;
            refreshToken: string;
            refreshTokenExpiresAt: string;
          };
          this.opts.onTokenRefreshed?.(data);
          return data.accessToken;
        } catch {
          this.opts.onRefreshFailed?.();
          return null;
        } finally {
          // Clear the in-flight slot so a future 401 can refresh again.
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  /**
   * Fetch a file (CSV, PDF) with the same auth and refresh-on-401 that
   * every other request gets.
   *
   * Its own method because `request` parses JSON, and a download must
   * not. The two download call sites in this app each hand-rolled a
   * `fetch` with `localStorage.getItem("loan.auth.token")` — which
   * works until the access token expires, at which point the download
   * reports "Server returned 401" instead of quietly refreshing and
   * retrying like everything else on the page. It also duplicated the
   * storage key, so renaming it in the auth provider would have broken
   * both silently.
   */
  async fetchBlob(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<Blob> {
    const token = this.opts.getToken?.();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // A body implies JSON here, same as `request` — the one caller
    // that posts (the DSAR export) sends a reason object.
    if (init.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (res.status === 401 && retry) {
      const nextToken = await this.tryRefresh();
      if (nextToken) return this.fetchBlob(path, init, false);
    }
    if (!res.ok) {
      const text = await res.text();
      const parsed = safeParse(text);
      const message =
        parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof parsed.message === "string"
          ? (parsed as { message: string }).message
          : `API ${res.status}`;
      throw new ApiError(res.status, message, parsed);
    }
    return res.blob();
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let singleton: ApiClient | null = null;

export function configureApiClient(opts: ApiClientOptions): ApiClient {
  // Reuse, never replace. See `ApiClient.reconfigure` — a second
  // instance means a second single-flight slot, which means two
  // concurrent refreshes with one token and a false theft alarm.
  if (singleton) {
    singleton.reconfigure(opts);
    return singleton;
  }
  singleton = new ApiClient(opts);
  return singleton;
}

export function getApiClient(): ApiClient {
  if (!singleton)
    throw new Error(
      "ApiClient not configured. Call configureApiClient() at startup.",
    );
  return singleton;
}
