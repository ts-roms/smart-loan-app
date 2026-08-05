import {
  logoutSession,
  useBranding,
  useEffectiveIdlePolicy,
} from "@loan/api-client";
import { Button, IdleWarningDialog, cn, useIdleLogout } from "@loan/ui";
import {
  BookOpen,
  CreditCard,
  FileCheck2,
  Gauge,
  HandCoins,
  LogOut,
  Menu,
  PiggyBank,
  Plus,
  UserCircle,
  Wallet,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../providers/auth";
import { Breadcrumbs } from "./Breadcrumbs";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Borrower-facing chrome. Lighter than the officer DashboardShell — no
 * customers/KYC review/accounting nav. The customer sees only what
 * relates to their own loans + docs + payments.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const { user, signOut, refreshToken } = useAuth();
  const navigate = useNavigate();
  // Off-canvas nav state — only meaningful below md.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  // Tapping a link should close the drawer; otherwise the scrim stays
  // over the page you just asked for.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);
  const handleSignOut = () => {
    if (refreshToken) void logoutSession(refreshToken).catch(() => {});
    signOut();
  };

  // Same branding pull as the staff shell — the portal sidebar should
  // reflect whatever the admin configured.
  const branding = useBranding();
  const brandName = branding.data?.companyName ?? "SmartLoan";
  const brandTagline = branding.data?.companyTagline ?? "Borrower portal";
  const brandLogo = branding.data?.companyLogoUrl ?? null;
  useEffect(() => {
    if (branding.data?.companyName) {
      document.title = branding.data.companyName + " · Portal";
    }
  }, [branding.data?.companyName]);

  // Same idle-then-logout wiring as the officer shell — borrowers
  // sitting on a kiosk shouldn't leave the session open either.
  const idlePolicy = useEffectiveIdlePolicy();
  const idle = useIdleLogout({
    idleSeconds: idlePolicy.idleTimeoutSeconds,
    warningSeconds: idlePolicy.idleWarningSeconds,
    enabled: !!user && !idlePolicy.isLoading,
    onLogout: () => {
      handleSignOut();
      void navigate("/login");
    },
  });

  return (
    // Same sticky-sidebar pattern as the officer DashboardShell — viewport
    // height locked, only the main column scrolls.
    <div className="h-screen flex overflow-hidden">
      {/* Same off-canvas treatment as the staff shell — a fixed 240px
          rail leaves a phone with 135px of content. Borrowers are the
          likeliest of all our users to be on one. */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 md:hidden"
        />
      )}
      <aside
        className={cn(
          "w-60 shrink-0 border-r border-default bg-surface-2 backdrop-blur-md flex flex-col h-full",
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="px-4 py-5 border-b border-default">
          <div className="flex items-center gap-2">
            {/* Configured logo (PNG/SVG) or default glyph. Sized to
                match the dashboard shell so an admin who uploads a
                logo gets a consistent appearance across both surfaces. */}
            <div className="h-7 w-7 rounded-md bg-primary-soft border border-default flex items-center justify-center overflow-hidden shrink-0">
              {brandLogo ? (
                <img
                  src={brandLogo}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <Wallet className="h-4 w-4 text-info" />
              )}
            </div>
            <span className="text-lg font-semibold tracking-tight truncate">
              {brandName}
            </span>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-fg-subtle mt-1 truncate">
            {brandTagline}
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {[
            { to: "/portal", label: "Dashboard", icon: Gauge, end: true },
            { to: "/portal/apply", label: "New loan", icon: Plus, end: false },
            {
              to: "/portal/loans",
              label: "My loans",
              icon: CreditCard,
              end: false,
            },
            {
              to: "/portal/savings",
              label: "My savings",
              icon: PiggyBank,
              end: false,
            },
            {
              to: "/portal/contributions",
              label: "Contributions",
              icon: HandCoins,
              end: false,
            },
            {
              to: "/portal/ledger",
              label: "My ledger",
              icon: BookOpen,
              end: false,
            },
            {
              to: "/portal/kyc",
              label: "Documents",
              icon: FileCheck2,
              end: false,
            },
            {
              to: "/portal/profile",
              label: "My profile",
              icon: UserCircle,
              end: false,
            },
          ].map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-surface-3 text-fg"
                    : "text-fg hover:bg-hover hover:text-fg",
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-default px-3 py-3 space-y-2">
          <div className="text-xs">
            <div className="font-medium truncate">{user?.name ?? "—"}</div>
            <div className="text-fg-subtle truncate">{user?.email}</div>
            <div className="text-[10px] uppercase tracking-wider text-info mt-0.5">
              Borrower
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleSignOut}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 h-full overflow-y-auto">
        <div className="md:hidden sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-default bg-background/85 backdrop-blur-xl px-3">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-medium truncate">{brandName}</span>
        </div>
        {/* Keyed on the route so the entrance replays per navigation —
            see the note in DashboardShell. */}
        <div
          key={pathname}
          className="page-enter p-6 max-w-5xl mx-auto space-y-4"
        >
          <Breadcrumbs variant="portal" />
          {children}
        </div>
      </main>
      <IdleWarningDialog state={idle} />
    </div>
  );
}
