import type { UserRole } from '@loan/shared-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const TOKEN_KEY = 'loan.auth.token';
const REFRESH_KEY = 'loan.auth.refresh';
const USER_KEY = 'loan.auth.user';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface SignInPayload {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface AuthApi {
  /** Short-lived JWT access token (24h). */
  token: string | null;
  /** Long-lived random refresh token (30 days). */
  refreshToken: string | null;
  user: AuthUser | null;
  signIn: (payload: SignInPayload) => void;
  signOut: () => void;
  /** Stored-token replacement, used by ApiClient when /auth/refresh rotates. */
  applyRefresh: (next: { accessToken: string; refreshToken: string }) => void;
}

const AuthCtx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [refreshToken, setRefreshToken] = useState<string | null>(() =>
    localStorage.getItem(REFRESH_KEY),
  );
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  });

  // Keep refs in sync so the ApiClient's getToken/getRefreshToken can read
  // the *current* value, not whichever value was captured at provider mount.
  const tokenRef = useRef(token);
  const refreshRef = useRef(refreshToken);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    refreshRef.current = refreshToken;
  }, [refreshToken]);

  const signIn = useCallback((payload: SignInPayload) => {
    localStorage.setItem(TOKEN_KEY, payload.accessToken);
    localStorage.setItem(REFRESH_KEY, payload.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    setToken(payload.accessToken);
    setRefreshToken(payload.refreshToken);
    setUser(payload.user);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  const applyRefresh = useCallback(
    (next: { accessToken: string; refreshToken: string }) => {
      localStorage.setItem(TOKEN_KEY, next.accessToken);
      localStorage.setItem(REFRESH_KEY, next.refreshToken);
      setToken(next.accessToken);
      setRefreshToken(next.refreshToken);
    },
    [],
  );

  // Cross-tab logout
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY && !e.newValue) {
        setToken(null);
        setRefreshToken(null);
        setUser(null);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const value = useMemo<AuthApi>(
    () => ({ token, refreshToken, user, signIn, signOut, applyRefresh }),
    [token, refreshToken, user, signIn, signOut, applyRefresh],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
