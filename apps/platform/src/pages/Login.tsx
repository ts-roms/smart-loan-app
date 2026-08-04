import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { btnPrimary, inputStyle } from "../App";
import { makeApi, useAuth, type PlatformUser } from "../AuthProvider";

/**
 * Platform login. Single form, no remember-me, no SSO — the platform
 * console is internal so we keep auth straightforward.
 */
export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const api = makeApi(null);
      const res = await api<{ token: string; user: PlatformUser }>(
        "/platform/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        },
      );
      signIn(res.token, res.user);
      void navigate("/tenants", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 360,
          padding: 32,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>SmartLoan Platform</h1>
        <p
          style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 24px" }}
        >
          Vendor console — tenants, licenses, audit.
        </p>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
            required
            autoComplete="username"
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            required
            autoComplete="current-password"
          />
        </div>
        {error && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: 12,
              background: "var(--danger-soft)",
              border: "1px solid var(--danger-ring)",
              borderRadius: 4,
              fontSize: 13,
              color: "var(--danger)",
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{ ...btnPrimary, width: "100%" }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  marginBottom: 4,
  color: "var(--text-dim)",
};
