import { Navigate, Route, Routes, Link, useLocation } from "react-router-dom";

import { useAuth } from "./AuthProvider";
import { Audit } from "./pages/Audit";
import { IssueLicense } from "./pages/IssueLicense";
import { Login } from "./pages/Login";
import { TenantDetail } from "./pages/TenantDetail";
import { TenantsList } from "./pages/TenantsList";

/**
 * Top-level routing. Public routes (login) + a single protected
 * shell for the rest. No nested layouts — the platform console is
 * small enough that one shell handles everything.
 */
export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <FullPage>Loading…</FullPage>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/tenants" replace />} />
        <Route path="/tenants" element={<TenantsList />} />
        <Route path="/tenants/:slug" element={<TenantDetail />} />
        <Route path="/licenses/issue" element={<IssueLicense />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/tenants" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const loc = useLocation();
  const isActive = (path: string) => loc.pathname.startsWith(path);
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 200,
          borderRight: "1px solid #1e293b",
          padding: 20,
          background: "#0e1525",
        }}
      >
        <h1 style={{ fontSize: 16, margin: "0 0 24px" }}>SmartLoan Platform</h1>
        <nav style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <NavLink to="/tenants" active={isActive("/tenants")}>
            Tenants
          </NavLink>
          <NavLink to="/licenses/issue" active={isActive("/licenses")}>
            Issue license
          </NavLink>
          {user?.role === "PLATFORM_ADMIN" && (
            <NavLink to="/audit" active={isActive("/audit")}>
              Audit log
            </NavLink>
          )}
        </nav>
        <div
          style={{
            position: "absolute",
            bottom: 20,
            fontSize: 12,
            color: "#64748b",
          }}
        >
          <div>{user?.email}</div>
          <div style={{ marginBottom: 8 }}>{user?.role}</div>
          <button onClick={signOut} style={btnSecondary}>
            Sign out
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 32 }}>{children}</main>
    </div>
  );
}

function NavLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        color: active ? "#60a5fa" : "#cbd5e1",
        textDecoration: "none",
        fontSize: 14,
        padding: "6px 8px",
        borderRadius: 4,
        background: active ? "#1e293b" : "transparent",
      }}
    >
      {children}
    </Link>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      {children}
    </div>
  );
}

// ─── shared inline styles ───────────────────────────────────────────────
export const btnPrimary: React.CSSProperties = {
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 14,
  cursor: "pointer",
};

export const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "#cbd5e1",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
};

export const inputStyle: React.CSSProperties = {
  background: "#0a0f1e",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};
