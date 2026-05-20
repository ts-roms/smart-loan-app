import { logoutSession } from '@loan/api-client';
import { Button, cn } from '@loan/ui';
import { CreditCard, FileCheck2, Gauge, LogOut, Plus, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../providers/auth';

/**
 * Borrower-facing chrome. Lighter than the officer DashboardShell — no
 * customers/KYC review/accounting nav. The customer sees only what
 * relates to their own loans + docs + payments.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const { user, signOut, refreshToken } = useAuth();
  const handleSignOut = () => {
    if (refreshToken) void logoutSession(refreshToken).catch(() => {});
    signOut();
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
            Borrower portal
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1">
          {[
            { to: '/portal', label: 'Dashboard', icon: Gauge, end: true },
            { to: '/portal/apply', label: 'New loan', icon: Plus, end: false },
            { to: '/portal/loans', label: 'My loans', icon: CreditCard, end: false },
            { to: '/portal/kyc', label: 'Documents', icon: FileCheck2, end: false },
          ].map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-white/[0.08] text-white'
                    : 'text-white/70 hover:bg-white/[0.04] hover:text-white',
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 px-3 py-3 space-y-2">
          <div className="text-xs">
            <div className="font-medium truncate">{user?.name ?? '—'}</div>
            <div className="text-white/45 truncate">{user?.email}</div>
            <div className="text-[10px] uppercase tracking-wider text-sky-300/80 mt-0.5">
              Borrower
            </div>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={handleSignOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="p-6 max-w-5xl mx-auto space-y-4">{children}</div>
      </main>
    </div>
  );
}
