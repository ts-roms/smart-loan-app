import { configureApiClient } from "@loan/api-client";
import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./auth";

/**
 * Configures the singleton ApiClient against the current auth token.
 * Every TanStack Query hook reads from `getApiClient()` and inherits the
 * latest token automatically — no per-call wiring required.
 *
 * Wires the refresh-token plumbing so a 401 on any request triggers one
 * `/auth/refresh` round-trip and a transparent retry. Refresh failure
 * sign-outs the user.
 *
 * Phase 2: the tenant slug is read out of the JWT's `tenant` claim and
 * forwarded with refresh requests so the server knows which schema's
 * RefreshToken table to look in. Decoding inline keeps the change local;
 * we don't need to introduce a new auth-provider field.
 */
export function ApiClientProvider({ children }: { children: ReactNode }) {
  const { token, refreshToken, applyRefresh, signOut } = useAuth();

  /*
   * Keep refs to the current token/refreshToken so the ApiClient
   * callbacks — configured once at mount — always read the latest
   * values.
   *
   * Assigned during render, NOT in an effect. React runs child effects
   * before parent ones, so a `useEffect` here landed after the newly
   * mounted tree had already fired its queries: signing in mounted
   * DashboardShell, which requested /auth/me/permissions while this ref
   * still held the pre-login token, took a 401, and cached it. The
   * sidebar renders from that response, so it came up nearly empty and
   * — thanks to a 60s staleTime — stayed that way. Writing the ref
   * during render means anything that renders after this point sees the
   * new token. Safe as a plain latest-value mirror: idempotent, no
   * subscription, nothing else reads it during render.
   */
  const tokenRef = useRef(token);
  const refreshRef = useRef(refreshToken);
  tokenRef.current = token;
  refreshRef.current = refreshToken;

  const config = {
    baseUrl: "/api/v1",
    getToken: () => tokenRef.current,
    getRefreshToken: () => refreshRef.current,
    getTenantSlug: () => tenantSlugFromJwt(tokenRef.current),
    onTokenRefreshed: (next: {
      accessToken: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    }) => {
      applyRefresh({
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
      });
    },
    onRefreshFailed: () => {
      signOut();
    },
  };

  useEffect(() => {
    configureApiClient(config);
    // Configured once at mount — refs handle the live values. No deps so
    // we don't tear down + reconfigure on every token rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run once eagerly so the very first render has a configured client.
  if (typeof window !== "undefined" && !ApiClientProvider._bootstrapped) {
    configureApiClient(config);
    ApiClientProvider._bootstrapped = true;
  }

  return <>{children}</>;
}
ApiClientProvider._bootstrapped = false as boolean;

/**
 * Decode the `tenant` claim from a JWT access token. Returns null when:
 *   - The token is null/empty
 *   - The token doesn't parse (malformed three-segment shape)
 *   - The payload has no `tenant` field (tokens minted before P2.3)
 *
 * No signature verification — that's the server's job. We just need
 * to read the claim so we can echo it back on refresh.
 */
function tenantSlugFromJwt(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  const rawPayload = parts[1];
  if (parts.length !== 3 || !rawPayload) return null;
  try {
    // base64url → base64 → JSON
    const payload = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    // atob can't handle missing padding; pad to multiple of 4.
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as { tenant?: unknown };
    return typeof parsed.tenant === "string" ? parsed.tenant : null;
  } catch {
    return null;
  }
}
