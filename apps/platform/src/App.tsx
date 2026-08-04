import { useEffect, useState } from "react";
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

  // Off-canvas nav state. Only has an effect below 768px — above that
  // the media query pins the rail back in flow and ignores data-open.
  const [navOpen, setNavOpen] = useState(false);
  // Tapping a link should close the drawer rather than leave the scrim
  // sitting over the page just requested.
  useEffect(() => {
    setNavOpen(false);
  }, [loc.pathname]);

  return (
    <div className="pf-shell">
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="pf-scrim"
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside className="pf-aside" data-open={navOpen ? "true" : "false"}>
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
            color: "var(--text-muted)",
          }}
        >
          <div>{user?.email}</div>
          <div style={{ marginBottom: 8 }}>{user?.role}</div>
          <button onClick={signOut} style={btnSecondary}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="pf-main">
        {/* Only reachable below md, where the rail is off-canvas. */}
        <button
          type="button"
          className="pf-burger"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          ☰
        </button>
        {children}
      </main>
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
        color: active ? "var(--accent)" : "var(--text)",
        textDecoration: "none",
        fontSize: 14,
        padding: "6px 8px",
        borderRadius: 4,
        background: active ? "var(--border)" : "transparent",
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
  background: "var(--accent-strong)",
  color: "white",
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 14,
  cursor: "pointer",
};

export const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
};

export const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};
