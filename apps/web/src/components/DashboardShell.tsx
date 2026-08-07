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
  sweepDriverResidue,
  useIdleLogout,
} from "@loan/ui";
import {
  Banknote,
  BarChart3,
  BookOpenCheck,
  CalendarClock,
  Car,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
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
  Briefcase,
  Handshake,
  ScrollText,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../providers/auth";
import { ActiveDelegationBanner } from "../features/delegations";
import { LicenseBanner } from "../features/settings";
import { HelpTrigger } from "../features/help";
import { NotificationBell } from "../features/notifications";
import { Breadcrumbs } from "./Breadcrumbs";
import { SidebarPattern } from "./SidebarPattern";
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
        to: "/pre-assessments",
        label: "Pre-assessment",
        icon: ClipboardCheck,
        permission: "pre_assessment.run",
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
      {
        to: "/agents",
        label: "Agents",
        icon: Handshake,
        permission: "agents.read",
      },
      /*
       * The agent's own page, gated on `agents.self` — which the AGENT
       * role holds and nobody else does. That is what makes this the
       * only nav item an agent sees: the shell renders from permissions,
       * so their sidebar is one link rather than a list of dead ends.
       */
      {
        to: "/my-book",
        label: "My book",
        icon: Briefcase,
        permission: "agents.self",
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
        /*
         * `loans.read`, matching the list endpoint the page calls — NOT
         * `repossession.identify`. The step permissions exist so RBAC
         * can route the chain to separate roles (BM / Credit Head /
         * Legal), and gating the nav on `identify` locked every one of
         * those approvers out of the page their step lives on: a
         * Legal-only role had a pending approval and no way to reach
         * it. Each action still gates on its own step key inside.
         */
        to: "/repossession",
        label: "Repossession",
        icon: ShieldAlert,
        permission: "loans.read",
      },
      {
        to: "/lease",
        label: "Lease-to-Own",
        icon: Car,
        permission: "lease.read",
      },
      {
        // The cashier's counter — search a loan, record a payment.
        to: "/payments",
        label: "Payments",
        icon: Wallet,
        permission: "payments.record",
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
        to: "/questionnaires",
        label: "Questionnaires",
        icon: ClipboardList,
        permission: "products.read",
      },
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
        to: "/compliance/privacy",
        label: "Data privacy",
        icon: ShieldCheck,
        permission: "admin.compliance",
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
      {
        to: "/audit",
        label: "Audit log",
        icon: ScrollText,
        permission: "admin.audit_log",
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
        // py-2 over py-1.5, gap-3 over gap-2.5. The old row was ~30px
        // tall in a rail whose reference is ~47px; the difference reads
        // as a cramped list rather than as a dense one, and the icons
        // ran into their labels.
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors",
        "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity",
        active
          ? // A white-alpha wash rather than a solid pill: the rail is
            // dark now, and a white pill would invert the text with it.
            "bg-white/[0.12] text-fg before:opacity-100"
          : "text-fg-muted hover-sidebar hover:text-fg",
      )}
    >
      <item.icon className="h-[18px] w-[18px] shrink-0" />
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
  //
  // The `??` fallback matters more than it looks. Dashboard is the one
  // item in the UNLABELLED section, so on `/` nothing matched and every
  // accordion stayed shut: the landing page every officer sees first
  // offered a nav containing exactly one link, with the rest of the app
  // behind six headings they had to guess between. Falling back to the
  // first labelled section means the rail always shows somewhere to go.
  //
  // Only the initial value — `toggle` still sets null, so closing a
  // section by hand leaves it closed rather than springing back open.
  const sectionWithRoute =
    NAV_SECTIONS.find(
      (s) => s.label && s.items.some((i) => i.to === activePath),
    )?.label ??
    NAV_SECTIONS.find((s) => s.label)?.label ??
    null;

  // Off-canvas nav state — only meaningful below the md breakpoint.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Navigating from the drawer should close it; otherwise the overlay
  // stays over the page you just asked for.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [currentPath]);

  /*
   * The shell is the viewport (h-screen + overflow-hidden); <main> is
   * the only intended scroller. That assumption was never ENFORCED:
   * anything with real height that lands directly in <body> — a leaked
   * third-party overlay, an extension-injected element — makes the
   * document taller than the viewport, and the page grows a second,
   * body-level scrollbar with a dead region below the shell. Locking
   * body overflow while the shell is mounted makes the assumption a
   * rule. Scoped here rather than in global CSS because the login and
   * registration pages genuinely rely on body scroll.
   */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Belt and braces against stranded tour overlays: sweep on every
  // route change, not only on pages that mount a TourButton — detail
  // pages have no tour, so a sweep scoped to useTour never ran there.
  useEffect(() => {
    sweepDriverResidue();
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
    //
    // No `bg-background` here. It painted `hsl(var(--background))`
    // opaquely across the whole viewport — the same colour the body
    // already paints, so it looked identical while hiding everything
    // layered underneath: the two radial glows the body defines, and now
    // the cover pattern. PortalShell never had it, which is why the
    // portal has been showing those glows and the console hasn't.
    // Dropping it makes them agree and changes no colour.
    <div className="h-screen flex overflow-hidden">
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
          "w-60 shrink-0 border-r border-sidebar bg-sidebar flex flex-col h-full isolate",
          // Off-canvas on small screens, in-flow from md up.
          // `md:relative` rather than `md:static`: the cover pattern below
          // is an absolutely-positioned child and needs the rail itself
          // as its containing block, or it would size against the
          // viewport. `relative` sits in flow exactly as `static` does.
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:relative md:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarPattern />

        {/*
          h-14 matches the main header exactly, so the two bottom borders
          meet and read as one line across the top of the app instead of
          stepping 18px at the rail's edge.
        */}
        <div className="flex h-14 shrink-0 items-center border-b border-default px-4">
          <div className="flex min-w-0 items-center gap-3">
            {/*
              An uploaded logo is someone else's artwork, drawn almost
              always for a light background, so it gets a solid white
              tile — the only container that can't swallow it. The
              built-in fallback is ours and can sit straight on the rail.
            */}
            <div
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md",
                brandLogo ? "bg-white p-1" : "bg-primary-soft text-primary",
              )}
            >
              {brandLogo ? (
                <img
                  src={brandLogo}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <Wallet className="h-[18px] w-[18px]" />
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[20px] font-semibold leading-tight tracking-tight">
                {brandName}
              </div>
              <div className="truncate text-[10px] uppercase leading-tight tracking-wider text-fg-subtle">
                {brandTagline}
              </div>
            </div>
          </div>
        </div>

        {/*
          Group separation lives on the section headings (`pt-5`), not as
          a uniform `space-y` on this nav. A flat gap between every child
          spaces the unsectioned top block away from the logo for no
          reason and still leaves the headings sitting right on top of
          the group above them — which is what made three distinct groups
          read as one long list.
        */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section, idx) => {
            const items = visibleItems(section.items, permissions);
            if (items.length === 0) return null;

            // Unsectioned (no label) — render the items directly. This is
            // how "Dashboard" stays pinned to the top, always visible.
            if (!section.label) {
              return (
                <div key={`section-${idx}`} className="space-y-1">
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
              <div key={section.label} className="space-y-1 pt-5">
                <button
                  type="button"
                  onClick={() => toggle(section.label!)}
                  aria-expanded={isOpen}
                  className={cn(
                    // The heading is a label first and a control second,
                    // so it sits at the same px-3 as the rows beneath it
                    // — a heading indented differently from its own group
                    // stops looking like it belongs to it.
                    "group flex w-full items-center justify-between rounded-md px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors",
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
                    <div className="space-y-1">
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
        {/*
          `key` on the pathname, not just the class. Without it React
          reuses this subtree across navigations, the CSS animation
          never restarts, and only the very first page ever animates.
          Re-keying remounts the children, which replays it.
        */}
        <div key={currentPath} className="page-enter p-6 space-y-4">
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
