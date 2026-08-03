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
  PiggyBank,
  Plus,
  UserCircle,
  Wallet,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../providers/auth";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Borrower-facing chrome. Lighter than the officer DashboardShell — no
 * customers/KYC review/accounting nav. The customer sees only what
 * relates to their own loans + docs + payments.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const { user, signOut, refreshToken } = useAuth();
  const navigate = useNavigate();
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
      <aside className="w-60 shrink-0 border-r border-default bg-surface-2 backdrop-blur-md flex flex-col h-full">
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
            <div className="text-[10px] uppercase tracking-wider text-info/80 mt-0.5">
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
        <div className="p-6 max-w-5xl mx-auto space-y-4">{children}</div>
      </main>
      <IdleWarningDialog state={idle} />
    </div>
  );
}
