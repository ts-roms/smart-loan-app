import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Auth state for the platform console. The JWT lives in localStorage
 * (the consumer is the vendor's own team on managed devices — same
 * tradeoff the tenant app made). On mount we hit /platform/me to
 * verify the stored token; failure → drop the token and force re-login.
 */

const TOKEN_KEY = "smartloan-platform-token";

export interface PlatformUser {
  id: string;
  email: string;
  role: "PLATFORM_ADMIN" | "PLATFORM_SALES";
}

interface AuthContextValue {
  user: PlatformUser | null;
  token: string | null;
  loading: boolean;
  signIn: (token: string, user: PlatformUser) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    typeof localStorage !== "undefined"
      ? localStorage.getItem(TOKEN_KEY)
      : null,
  );
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [loading, setLoading] = useState(Boolean(token));

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setUser(null);
      return;
    }
    let cancelled = false;
    fetch("/platform/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<PlatformUser>;
      })
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Token is stale or invalid — drop it and bounce to login.
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const signIn = (newToken: string, u: PlatformUser) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(u);
  };

  const signOut = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, token, loading, signIn, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Shared fetch wrapper that adds the bearer token + parses the JSON
 * response. Throws on non-2xx with the server's message string when
 * available.
 */
export function makeApi(token: string | null) {
  return async function api<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "message" in body
          ? String(body.message)
          : `Request failed with ${res.status}`;
      throw new Error(msg);
    }
    return body as T;
  };
}
