import {
  logoutSession,
  useBranding,
  useEffectiveIdlePolicy,
  useMyPermissions,
} from "@loan/api-client";
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IdleWarningDialog,
  cn,
  useIdleLogout,
} from "@loan/ui";
import {
  Banknote,
  BarChart3,
  BookOpenCheck,
  CalendarClock,
  Car,
  ChevronDown,
  Clock,
  CreditCard,
  FileCheck2,
  FileSpreadsheet,
  Gauge,
  HandCoins,
  Inbox,
  KeyRound,
  Layers,
  LogOut,
  Mail,
  Menu,
  Package,
  PhoneCall,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserCircle,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../providers/auth";
import { ActiveDelegationBanner } from "../features/delegations";
import { LicenseBanner } from "../features/settings";
import { AuditLogTrigger } from "../features/audit";
import { HelpTrigger } from "../features/help";
import { NotificationBell } from "../features/notifications";
import { Breadcrumbs } from "./Breadcrumbs";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  /**
   * Permission that reveals this entry. Omit for pages every signed-in
   * staff user can reach.
   *
   * Deliberately the same key the API gates the route with. This used
   * to be a list of UserRole values, which drifted the moment a role
   * existed outside that four-value enum: the API resolves access from
   * UserRoleAssignment → Role → RolePermission and never consults
   * User.role, so a COLLECTOR — or any custom role an admin builds at
   * /roles — was granted the endpoint and then shown no way to reach
   * it. Naming the permission means the rail and the route agree by
   * construction.
   */
  permission?: string;
}

interface NavSection {
  /** Section label shown as a small uppercase divider. Omit for unlabeled. */
  label?: string;
  items: NavItem[];
}

/**
 * Sidebar nav grouped by operational area. Each section's header only
 * renders when at least one item inside is visible to the current user —
 * so a collector never sees an empty "Administration" stub.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ to: "/", label: "Dashboard", icon: Gauge }],
  },
  {
    label: "Customers & loans",
    items: [
      {
        to: "/customers",
        label: "Customers",
        icon: Users,
        permission: "customers.read",
      },
      {
        to: "/customers/bulk",
        label: "Bulk import",
        icon: FileSpreadsheet,
        permission: "customers.write",
      },
      {
        to: "/kyc",
        label: "KYC review",
        icon: FileCheck2,
        permission: "kyc.read",
      },
      {
        to: "/loans",
        label: "Loans",
        icon: CreditCard,
        permission: "loans.read",
      },
      {
        to: "/loan-products",
        label: "Loan products",
        icon: Package,
        permission: "products.read",
      },
    ],
  },
  {
    label: "Servicing",
    items: [
      {
        to: "/collections/my-accounts",
        label: "My accounts",
        icon: Inbox,
        permission: "collections.read",
      },
      {
        to: "/collections",
        label: "Collections",
        icon: PhoneCall,
        permission: "collections.read",
      },
      {
        to: "/collections/demand-letters",
        label: "Demand letters",
        icon: Mail,
        permission: "collections.demand_letter",
      },
      {
        to: "/repossession",
        label: "Repossession",
        icon: ShieldAlert,
        permission: "repossession.identify",
      },
      {
        to: "/lease",
        label: "Lease-to-Own",
        icon: Car,
        permission: "lease.read",
      },
      {
        to: "/payments/bulk",
        label: "Bulk payments",
        icon: FileSpreadsheet,
        permission: "payments.bulk",
      },
    ],
  },
  {
    label: "Accounting",
    items: [
      {
        to: "/accounting",
        label: "Accounting",
        icon: BookOpenCheck,
        permission: "accounting.read",
      },
      {
        to: "/accounting/analytics",
        label: "Analytics",
        icon: BarChart3,
        permission: "accounting.read",
      },
      {
        to: "/accounting/ecl",
        label: "ECL provisioning",
        icon: Layers,
        permission: "accounting.read",
      },
      {
        to: "/reconciliation",
        label: "Bank reconciliation",
        icon: Banknote,
        permission: "accounting.read",
      },
    ],
  },
  {
    label: "Cooperative",
    items: [
      {
        to: "/cooperative",
        label: "Contributions & funds",
        icon: HandCoins,
        permission: "coop.read",
      },
    ],
  },
  {
    label: "Risk & compliance",
    items: [
      {
        to: "/decision-rules",
        label: "Decision rules",
        icon: ShieldCheck,
        permission: "admin.decision_rules",
      },
      {
        to: "/screening",
        label: "AML watchlist",
        icon: ShieldAlert,
        permission: "screening.read",
      },
      {
        to: "/compliance/annual-docs",
        label: "Renewable docs",
        icon: FileCheck2,
        permission: "loans.docs_renew",
      },
      {
        to: "/compliance/dorsi",
        label: "DORSI compliance",
        icon: Layers,
        permission: "dorsi.read",
      },
      {
        to: "/reports",
        label: "Reports",
        icon: BookOpenCheck,
        permission: "reports.read",
      },
      {
        to: "/notifications",
        label: "Notifications",
        icon: Mail,
        permission: "notifications.read",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        to: "/users",
        label: "Users",
        icon: UserCog,
        permission: "admin.users",
      },
      {
        to: "/users/bulk",
        label: "Bulk users",
        icon: FileSpreadsheet,
        permission: "admin.users",
      },
      {
        to: "/roles",
        label: "Roles",
        icon: KeyRound,
        permission: "admin.roles",
      },
      {
        // No gate: the page shows the caller's OWN delegations, and any
        // staff user can hold one. Only /delegations/all is privileged,
        // and that list isn't reachable from here. Matches what the old
        // roles list meant — every staff role, no customer.
        to: "/delegations",
        label: "Delegations",
        icon: CalendarClock,
      },
      {
        to: "/jobs",
        label: "Jobs",
        icon: Clock,
        permission: "jobs.read",
      },
    ],
  },
  // "Account" lives in the top-right avatar dropdown (My profile, Settings,
  // Log out) — no need to duplicate it in the sidebar.
];

/**
 * Entries the caller may actually reach.
 *
 * `perms` is undefined while /auth/me/permissions is in flight. That
 * counts as "nothing granted yet", not "everything" — the rail fills in
 * a beat later, whereas the optimistic reading flashes every admin
 * entry at a collector on each page load.
 */
function visibleItems(
  items: NavItem[],
  perms: ReadonlySet<string> | undefined,
): NavItem[] {
  return items.filter(
    (n) => !n.permission || (perms?.has(n.permission) ?? false),
  );
}

/** Does `path` fall under `to` — the item itself or any route below it? */
function coversRoute(to: string, path: string): boolean {
  if (to === "/") return path === "/";
  return path === to || path.startsWith(`${to}/`);
}

/**
 * Which single nav item owns `path` — the longest `to` that covers it.
 *
 * NavLink's own `isActive` can't decide this: it lights up on any
 * ancestor match, so `/collections/demand-letters` highlighted both
 * "Collections" and "Demand letters" at once. Four pairs in this sidebar
 * nest that way (collections, customers, users, accounting).
 *
 * `end` on every item would fix the double-highlight and break the
 * common case instead — `/customers/:id`, `/loans/new` and the eight
 * `/accounting/*` pages have no nav entry of their own and rely on the
 * parent staying lit. Longest-match satisfies both: a child claims the
 * route when one exists, otherwise the nearest ancestor keeps it.
 *
 * Scoped to entries the caller can actually see, so one hidden by
 * `permission` never steals the highlight from the visible parent.
 */
function activeNavPath(
  path: string,
  perms: ReadonlySet<string> | undefined,
): string | null {
  let best: string | null = null;
  for (const section of NAV_SECTIONS) {
    for (const item of visibleItems(section.items, perms)) {
      if (
        coversRoute(item.to, path) &&
        (!best || item.to.length > best.length)
      ) {
        best = item.to;
      }
    }
  }
  return best;
}

function NavItemLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      // Plain Link, not NavLink: active state comes from activeNavPath,
      // and NavLink would only ever set aria-current from its own match.
      // With `end` that drops the marker on `/customers/:id` (parent lit,
      // nothing announced); without it, it marks two items at once — the
      // same bug, moved to the accessibility tree where it's harder to
      // see. Setting it here keeps the visual and announced state equal.
      aria-current={active ? "page" : undefined}
      className={cn(
        // Subtle active state: a vertical accent rule on the left edge
        // plus a tinted surface. Looks more intentional than just a
        // darker background.
        "group relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors",
        "before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity",
        active
          ? "bg-surface-2 text-fg before:opacity-100"
          : "text-fg-muted hover:bg-surface-2/60 hover:text-fg",
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const { user, signOut, refreshToken } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // What the rail is allowed to show. Same source the API gates on, so
  // a role built at /roles gets a nav that matches its real access
  // instead of one derived from the four-value User.role enum.
  const myPerms = useMyPermissions();
  const permissions = useMemo(
    () => (myPerms.data ? new Set(myPerms.data.permissions) : undefined),
    [myPerms.data],
  );

  // Live branding — the shell falls back to defaults until the hook
  // resolves so first paint never shows nothing. document.title syncs
  // with the configured name so browser tabs reflect the org.
  const branding = useBranding();
  const brandName = branding.data?.companyName ?? "SmartLoan";
  const brandTagline = branding.data?.companyTagline ?? "Credit · KYC · Loans";
  const brandLogo = branding.data?.companyLogoUrl ?? null;
  useEffect(() => {
    if (branding.data?.companyName) {
      document.title = branding.data.companyName;
    }
  }, [branding.data?.companyName]);

  // Exactly one nav item is lit at a time; everything else keys off it.
  const currentPath = location.pathname;
  const activePath = activeNavPath(currentPath, permissions);

  // Find the section that item lives in so the matching accordion panel
  // opens by default — the user lands with their context already
  // expanded instead of having to click around for it.
  const sectionWithRoute =
    NAV_SECTIONS.find(
      (s) => s.label && s.items.some((i) => i.to === activePath),
    )?.label ?? null;

  // Off-canvas nav state — only meaningful below the md breakpoint.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Navigating from the drawer should close it; otherwise the overlay
  // stays over the page you just asked for.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [currentPath]);

  const [openSection, setOpenSection] = useState<string | null>(
    sectionWithRoute,
  );

  const toggle = (label: string) => {
    // Single-open behavior — clicking another section closes the current one.
    setOpenSection((curr) => (curr === label ? null : label));
  };

  // ─── Idle-then-logout ─────────────────────────────────────────────
  // Effective policy = min(org ceiling, per-user override). Wired up
  // here so both staff and borrower portal share the same convention
  // (PortalShell does the same dance with the same hook).
  const idlePolicy = useEffectiveIdlePolicy();
  const idle = useIdleLogout({
    idleSeconds: idlePolicy.idleTimeoutSeconds,
    warningSeconds: idlePolicy.idleWarningSeconds,
    enabled: !!user && !idlePolicy.isLoading,
    onLogout: () => {
      const rt = refreshToken;
      if (rt) void logoutSession(rt).catch(() => {});
      signOut();
      void navigate("/login");
    },
  });

  return (
    // h-screen + overflow-hidden pins the shell to the viewport so the
    // sidebar and header don't scroll with the page. Each interior region
    // (sidebar nav, main content) owns its own scroll instead.
    <div className="h-screen flex overflow-hidden bg-background">
      {/*
        Below md the sidebar slides over the content instead of sitting
        beside it. At 375px a fixed 240px rail left `main` with 135px,
        and after the page's own padding the inner panels were down to
        ~16px — narrow enough that the permission list on /roles rendered
        each key one character per line, stacked on its own label. No
        amount of truncation helps a 16px column; the rail has to go.
      */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 md:hidden"
        />
      )}
      <aside
        data-tour="nav-sidebar"
        className={cn(
          "w-60 shrink-0 border-r border-default bg-surface-1/80 backdrop-blur-md flex flex-col h-full",
          // Off-canvas on small screens, in-flow from md up.
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="px-4 py-5 border-b border-default">
          <div className="flex items-center gap-2.5">
            {/* Brand glyph — uses the uploaded logo when one is set,
                otherwise falls back to the built-in Wallet glyph. */}
            <div className="h-8 w-8 rounded-md bg-primary-soft border border-default flex items-center justify-center overflow-hidden">
              {brandLogo ? (
                <img
                  src={brandLogo}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <Wallet className="h-4 w-4 text-primary" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold tracking-tight leading-tight truncate">
                {brandName}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle leading-tight truncate">
                {brandTagline}
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {NAV_SECTIONS.map((section, idx) => {
            const items = visibleItems(section.items, permissions);
            if (items.length === 0) return null;

            // Unsectioned (no label) — render the items directly. This is
            // how "Dashboard" stays pinned to the top, always visible.
            if (!section.label) {
              return (
                <div key={`section-${idx}`} className="space-y-0.5">
                  {items.map((n) => (
                    <NavItemLink
                      key={n.to}
                      item={n}
                      active={n.to === activePath}
                    />
                  ))}
                </div>
              );
            }

            const isOpen = openSection === section.label;
            const hasActiveItem = items.some((i) => i.to === activePath);

            return (
              <div key={section.label} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => toggle(section.label!)}
                  aria-expanded={isOpen}
                  className={cn(
                    "group flex w-full items-center justify-between rounded-md px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors",
                    hasActiveItem
                      ? "text-fg"
                      : "text-fg-subtle hover:text-fg-muted",
                  )}
                >
                  <span>{section.label}</span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      isOpen ? "rotate-0" : "-rotate-90",
                    )}
                  />
                </button>
                {/*
                  CSS-grid collapse trick: animating grid-template-rows from
                  0fr → 1fr gives us a smooth height transition without
                  measuring children. The inner `min-h-0 overflow-hidden`
                  wrapper does the actual hiding.
                */}
                <div
                  className={cn(
                    "grid transition-[grid-template-rows] duration-200 ease-out",
                    isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-0.5 pb-1">
                      {items.map((n) => (
                        <NavItemLink
                          key={n.to}
                          item={n}
                          active={n.to === activePath}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      {/*
        main is the scroll container — its sticky header pins to the top
        of *this* region, not the viewport, so the sidebar stays put while
        only this column scrolls.
      */}
      <main className="flex-1 min-w-0 h-full overflow-y-auto">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-default bg-background/85 backdrop-blur-xl px-4 md:px-6">
          {/* Only route to the nav once the rail is off-canvas. */}
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
            className="md:hidden grid h-9 w-9 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <ThemeToggle />
          <span data-tour="navbar-help">
            <HelpTrigger />
          </span>
          <span data-tour="navbar-audit">
            <AuditLogTrigger />
          </span>
          <span data-tour="navbar-notifications">
            <NotificationBell />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open profile menu"
                data-tour="navbar-profile"
                className="flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition"
              >
                <Avatar name={user?.name ?? "—"} size="md" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]">
              {/* Profile header — avatar + name + email + role */}
              <div className="flex items-center gap-3 px-2 py-2">
                <Avatar name={user?.name ?? "—"} size="lg" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {user?.name ?? "—"}
                  </div>
                  <div className="text-xs text-fg-muted truncate">
                    {user?.email}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-info mt-0.5">
                    {user?.role}
                  </div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/profile" className="cursor-pointer">
                  <UserCircle className="h-4 w-4" />
                  My profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="cursor-pointer">
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  // Fire-and-forget revoke so a stolen refresh token in
                  // localStorage is invalidated server-side too. Sign out
                  // locally either way so the UX is instant.
                  const rt = refreshToken;
                  if (rt) void logoutSession(rt).catch(() => {});
                  signOut();
                  void navigate("/login");
                }}
                className="text-danger focus:text-danger"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        {/*
          Full-width content area. We previously capped at max-w-6xl
          which left a lot of whitespace on wider monitors — bad for
          data-heavy pages like the dashboard, analytics, and tables.
          The sidebar + header already give visual structure, so we
          don't need an inner column cap.
        */}
        <LicenseBanner />
        <div className="p-6 space-y-4">
          <ActiveDelegationBanner />
          <Breadcrumbs variant="staff" />
          {children}
        </div>
      </main>
      {/* Idle-then-logout warning. The dialog stays mounted at all times
          and only flips visible when the hook decides we've been idle. */}
      <IdleWarningDialog state={idle} />
    </div>
  );
}
