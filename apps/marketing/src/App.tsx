import { Link, Route, Routes, useLocation } from "react-router-dom";

import { Contact } from "./pages/Contact";
import { Home } from "./pages/Home";
import { Install } from "./pages/Install";
import { Pricing } from "./pages/Pricing";
import { Signup } from "./pages/Signup";
import { SignupConfirm } from "./pages/SignupConfirm";

/**
 * Where the tenant app lives. The marketing site and the app are
 * separate deployments (different ports in dev, usually different
 * hosts in production), so every "sign in" link has to be absolute.
 *
 * Set VITE_APP_URL at build time; the fallback is the dev server the
 * repo's `pnpm dev` starts.
 */
export const appUrl: string =
  (import.meta.env.VITE_APP_URL as string | undefined) ??
  "http://localhost:5173";

/**
 * Marketing site shell. Header + footer wrap every page; routes
 * render in the middle. No auth — everything here is public.
 *
 * Positioning: on-prem-first. The cooperative owns their data,
 * their hardware, their licensing terms. Hosted is a convenience
 * option, not the default.
 */
export function App() {
  return (
    <div
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}
    >
      <Header />
      <main style={{ flex: 1 }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/install" element={<Install />} />
          <Route path="/signup" element={<Signup />} />
          {/* Landing page for the emailed confirmation link. */}
          <Route path="/signup/confirm" element={<SignupConfirm />} />
          <Route path="/contact" element={<Contact />} />
          <Route
            path="*"
            element={
              <div style={{ padding: 80, textAlign: "center" }}>
                <h1>Not found</h1>
                <p style={{ color: "var(--text-dim)" }}>
                  <Link to="/">← Back home</Link>
                </p>
              </div>
            }
          />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  const loc = useLocation();
  const isActive = (p: string) =>
    p === "/" ? loc.pathname === "/" : loc.pathname.startsWith(p);
  return (
    <header
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-elev)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link
          to="/"
          style={{
            color: "var(--text)",
            textDecoration: "none",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: -0.3,
          }}
        >
          SmartLoan
        </Link>
        <nav style={{ display: "flex", gap: 28, alignItems: "center" }}>
          <NavLink to="/pricing" active={isActive("/pricing")}>
            Pricing
          </NavLink>
          <NavLink to="/install" active={isActive("/install")}>
            Install
          </NavLink>
          <NavLink to="/contact" active={isActive("/contact")}>
            Contact
          </NavLink>
          {/*
            Absolute, not a <Link> — the app is a separate deployment.
            Members and staff both land on the same login screen; which
            console they get is decided by their role once they're in.
          */}
          <a
            href={`${appUrl}/login`}
            style={{
              color: "var(--text-dim)",
              textDecoration: "none",
              fontSize: 14,
            }}
          >
            Sign in
          </a>
          <Link
            to="/signup"
            style={{
              background: "var(--accent-strong)",
              color: "white",
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
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
        color: active ? "var(--text)" : "var(--text-dim)",
        textDecoration: "none",
        fontSize: 14,
      }}
    >
      {children}
    </Link>
  );
}

function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-elev)",
        padding: "32px 24px",
        marginTop: 80,
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 32,
          flexWrap: "wrap",
        }}
      >
        <div style={{ maxWidth: 320 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 16,
              marginBottom: 8,
              color: "var(--text)",
            }}
          >
            SmartLoan
          </div>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: 13,
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            Loan management software built for Philippine cooperatives. On-prem
            first — your data on your hardware, with a perpetual license.
          </p>
        </div>
        <div style={{ display: "flex", gap: 40 }}>
          <FooterColumn
            title="Product"
            links={[
              { label: "Pricing", to: "/pricing" },
              { label: "Install", to: "/install" },
              { label: "Start a hosted trial", to: "/signup" },
            ]}
          />
          <FooterColumn
            title="Members"
            links={[
              { label: "Sign in", href: `${appUrl}/login` },
              { label: "Create an account", href: `${appUrl}/register` },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: "Contact", to: "/contact" },
              { label: "Platform console", href: "http://localhost:5174" },
            ]}
          />
        </div>
      </div>
      <div
        style={{
          maxWidth: 1100,
          margin: "32px auto 0",
          paddingTop: 20,
          borderTop: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        © {new Date().getFullYear()} SmartLoan. Built for Philippine
        cooperatives.
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ label: string; to?: string; href?: string }>;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {links.map((l) => (
          <li key={l.label} style={{ marginBottom: 8 }}>
            {l.to ? (
              <Link
                to={l.to}
                style={{
                  color: "var(--text-dim)",
                  fontSize: 13,
                  textDecoration: "none",
                }}
              >
                {l.label}
              </Link>
            ) : (
              <a
                href={l.href}
                style={{
                  color: "var(--text-dim)",
                  fontSize: 13,
                  textDecoration: "none",
                }}
              >
                {l.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── shared styles + primitives exported for pages ──────────────────

export const container: React.CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "24px 24px",
};

export const btnPrimary: React.CSSProperties = {
  background: "var(--accent-strong)",
  color: "white",
  border: "none",
  borderRadius: 8,
  padding: "12px 24px",
  fontSize: 15,
  fontWeight: 500,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

export const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "12px 24px",
  fontSize: 15,
  fontWeight: 500,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

export const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "10px 14px",
  fontSize: 14,
  width: "100%",
  fontFamily: "inherit",
};
