import { logoutSession } from '@loan/api-client';
import type { UserRole } from '@loan/shared-types';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@loan/ui';
import { Banknote, BarChart3, BookOpenCheck, CalendarClock, ChevronDown, Clock, CreditCard, FileCheck2, FileSpreadsheet, Gauge, HandCoins, KeyRound, Layers, LogOut, Mail, Package, PhoneCall, Settings, ShieldAlert, ShieldCheck, UserCircle, UserCog, Users, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/auth';
import { ActiveDelegationBanner } from '../features/delegations';
import { AuditLogTrigger } from '../features/audit';
import { NotificationBell } from '../features/notifications';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  roles?: ReadonlyArray<UserRole>;
}

interface NavSection {
  /** Section label shown as a small uppercase divider. Omit for unlabeled. */
  label?: string;
  items: NavItem[];
}

/**
 * Sidebar nav grouped by operational area. Each section's header only
 * renders when at least one item inside is visible to the current role —
 * so a customer never sees an empty "Administration" stub.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ to: '/', label: 'Dashboard', icon: Gauge }],
  },
  {
    label: 'Customers & loans',
    items: [
      { to: '/customers', label: 'Customers', icon: Users },
      { to: '/kyc', label: 'KYC review', icon: FileCheck2, roles: ['ADMIN', 'LOAN_OFFICER'] },
      { to: '/loans', label: 'Loans', icon: CreditCard },
      { to: '/loan-products', label: 'Loan products', icon: Package, roles: ['ADMIN'] },
    ],
  },
  {
    label: 'Servicing',
    items: [
      { to: '/collections', label: 'Collections', icon: PhoneCall, roles: ['ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT'] },
      { to: '/payments/bulk', label: 'Bulk payments', icon: FileSpreadsheet, roles: ['ADMIN', 'ACCOUNTANT'] },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { to: '/accounting', label: 'Accounting', icon: BookOpenCheck, roles: ['ADMIN', 'ACCOUNTANT'] },
      { to: '/accounting/analytics', label: 'Analytics', icon: BarChart3, roles: ['ADMIN', 'ACCOUNTANT', 'LOAN_OFFICER'] },
      { to: '/accounting/ecl', label: 'ECL provisioning', icon: Layers, roles: ['ADMIN', 'ACCOUNTANT'] },
      { to: '/reconciliation', label: 'Bank reconciliation', icon: Banknote, roles: ['ADMIN', 'ACCOUNTANT'] },
    ],
  },
  {
    label: 'Cooperative',
    items: [
      { to: '/cooperative', label: 'Contributions & funds', icon: HandCoins, roles: ['ADMIN', 'ACCOUNTANT'] },
    ],
  },
  {
    label: 'Risk & compliance',
    items: [
      { to: '/decision-rules', label: 'Decision rules', icon: ShieldCheck, roles: ['ADMIN'] },
      { to: '/screening', label: 'AML watchlist', icon: ShieldAlert, roles: ['ADMIN', 'LOAN_OFFICER'] },
      { to: '/notifications', label: 'Notifications', icon: Mail, roles: ['ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: UserCog, roles: ['ADMIN'] },
      { to: '/roles', label: 'Roles', icon: KeyRound, roles: ['ADMIN'] },
      { to: '/delegations', label: 'Delegations', icon: CalendarClock, roles: ['ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT'] },
      { to: '/jobs', label: 'Jobs', icon: Clock, roles: ['ADMIN', 'ACCOUNTANT'] },
    ],
  },
  // "Account" lives in the top-right avatar dropdown (My profile, Settings,
  // Log out) — no need to duplicate it in the sidebar.
];

function visibleItems(items: NavItem[], role: UserRole | undefined): NavItem[] {
  return items.filter((n) => !n.roles || (role && n.roles.includes(role)));
}

function NavItemLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          isActive
            ? 'bg-white/[0.08] text-white'
            : 'text-white/70 hover:bg-white/[0.04] hover:text-white',
        )
      }
    >
      <item.icon className="h-4 w-4" />
      {item.label}
    </NavLink>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const { user, signOut, refreshToken } = useAuth();
  const role = user?.role;
  const location = useLocation();
  const navigate = useNavigate();

  // Find the section the current route lives in so the matching accordion
  // panel opens by default — the user lands with their context already
  // expanded instead of having to click around for it.
  const currentPath = location.pathname;
  const sectionWithRoute =
    NAV_SECTIONS.find(
      (s) =>
        s.label &&
        s.items.some((i) =>
          i.to === '/'
            ? currentPath === '/'
            : currentPath === i.to || currentPath.startsWith(`${i.to}/`),
        ),
    )?.label ?? null;

  const [openSection, setOpenSection] = useState<string | null>(sectionWithRoute);

  const toggle = (label: string) => {
    // Single-open behavior — clicking another section closes the current one.
    setOpenSection((curr) => (curr === label ? null : label));
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 shrink-0 border-r border-white/10 bg-white/[0.02] backdrop-blur-md flex flex-col">
        <div className="px-4 py-5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-sky-300" />
            <span className="text-lg font-semibold tracking-tight">SmartLoan</span>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-white/40 mt-1">
            Credit · KYC · Loans
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {NAV_SECTIONS.map((section, idx) => {
            const items = visibleItems(section.items, role);
            if (items.length === 0) return null;

            // Unsectioned (no label) — render the items directly. This is
            // how "Dashboard" stays pinned to the top, always visible.
            if (!section.label) {
              return (
                <div key={`section-${idx}`} className="space-y-0.5">
                  {items.map((n) => (
                    <NavItemLink key={n.to} item={n} />
                  ))}
                </div>
              );
            }

            const isOpen = openSection === section.label;
            const hasActiveItem = items.some((i) =>
              i.to === '/'
                ? currentPath === '/'
                : currentPath === i.to || currentPath.startsWith(`${i.to}/`),
            );

            return (
              <div key={section.label} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => toggle(section.label!)}
                  aria-expanded={isOpen}
                  className={cn(
                    'group flex w-full items-center justify-between rounded-md px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                    hasActiveItem ? 'text-white' : 'text-white/45 hover:text-white/70',
                  )}
                >
                  <span>{section.label}</span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform duration-200',
                      isOpen ? 'rotate-0' : '-rotate-90',
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
                    'grid transition-[grid-template-rows] duration-200 ease-out',
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-0.5 pb-1">
                      {items.map((n) => (
                        <NavItemLink key={n.to} item={n} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-2 border-b border-white/10 bg-slate-950/60 backdrop-blur-md px-6">
          <AuditLogTrigger />
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open profile menu"
                className="flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 transition"
              >
                <Avatar name={user?.name ?? '—'} size="md" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]">
              {/* Profile header — avatar + name + email + role */}
              <div className="flex items-center gap-3 px-2 py-2">
                <Avatar name={user?.name ?? '—'} size="lg" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{user?.name ?? '—'}</div>
                  <div className="text-xs text-white/55 truncate">{user?.email}</div>
                  <div className="text-[10px] uppercase tracking-wider text-sky-300/80 mt-0.5">
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
                  navigate('/login');
                }}
                className="text-rose-300 focus:text-rose-200"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <div className="flex-1 min-w-0">
          <div className="p-6 max-w-6xl mx-auto space-y-4">
            <ActiveDelegationBanner />
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
