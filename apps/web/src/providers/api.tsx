import { configureApiClient } from '@loan/api-client';
import { useEffect, useRef, type ReactNode } from 'react';
import { useAuth } from './auth';

/**
 * Configures the singleton ApiClient against the current auth token.
 * Every TanStack Query hook reads from `getApiClient()` and inherits the
 * latest token automatically — no per-call wiring required.
 *
 * Wires the refresh-token plumbing so a 401 on any request triggers one
 * `/auth/refresh` round-trip and a transparent retry. Refresh failure
 * sign-outs the user.
 */
export function ApiClientProvider({ children }: { children: ReactNode }) {
  const { token, refreshToken, applyRefresh, signOut } = useAuth();

  // Keep refs to the current token/refreshToken values so the ApiClient
  // callbacks (which are configured once) always read the latest values.
  const tokenRef = useRef(token);
  const refreshRef = useRef(refreshToken);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    refreshRef.current = refreshToken;
  }, [refreshToken]);

  useEffect(() => {
    configureApiClient({
      baseUrl: '/api/v1',
      getToken: () => tokenRef.current,
      getRefreshToken: () => refreshRef.current,
      onTokenRefreshed: (next) => {
        applyRefresh({ accessToken: next.accessToken, refreshToken: next.refreshToken });
      },
      onRefreshFailed: () => {
        signOut();
      },
    });
    // Configured once at mount — refs handle the live values. No deps so
    // we don't tear down + reconfigure on every token rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run once eagerly so the very first render has a configured client.
  if (typeof window !== 'undefined' && !ApiClientProvider._bootstrapped) {
    configureApiClient({
      baseUrl: '/api/v1',
      getToken: () => tokenRef.current,
      getRefreshToken: () => refreshRef.current,
      onTokenRefreshed: (next) => {
        applyRefresh({ accessToken: next.accessToken, refreshToken: next.refreshToken });
      },
      onRefreshFailed: () => {
        signOut();
      },
    });
    ApiClientProvider._bootstrapped = true;
  }

  return <>{children}</>;
}
ApiClientProvider._bootstrapped = false as boolean;
