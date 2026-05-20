import { useCustomers, useLoans } from '@loan/api-client';
import { Card, CardContent, CardHeader, CardTitle, SkeletonCard } from '@loan/ui';
import { formatMoney } from '@loan/shared-utils';
import type { LoanApplication } from '@loan/shared-types';
import { CreditCard, FileCheck2, Users } from 'lucide-react';

/**
 * High-level snapshot for loan officers: how many customers we have,
 * how many loans are in flight, total principal outstanding. Drill-downs
 * live one click away on each card.
 */
export function DashboardPage() {
  const customers = useCustomers();
  const loans = useLoans();

  if (customers.isLoading || loans.isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
      </div>
    );
  }

  const totalCustomers = customers.data?.length ?? 0;
  const pendingKyc = (customers.data ?? []).filter((c) => c.kycStatus !== 'VERIFIED').length;
  const activeLoans = (loans.data ?? []).filter((l) =>
    ['APPROVED', 'DISBURSED', 'ACTIVE'].includes(l.status),
  );
  const outstanding = activeLoans.reduce((sum, l) => sum + Number(l.principal), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Customers" value={String(totalCustomers)} icon={Users} accent="sky" />
        <StatCard label="Pending KYC" value={String(pendingKyc)} icon={FileCheck2} accent="amber" />
        <StatCard
          label="Outstanding principal"
          value={formatMoney(outstanding)}
          icon={CreditCard}
          accent="emerald"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent loan activity</CardTitle>
        </CardHeader>
        <CardContent>
          {(loans.data ?? []).length === 0 ? (
            <p className="text-sm text-white/55">No loans yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {(loans.data ?? []).slice(0, 8).map((l) => (
                <LoanRow key={l.id} loan={l} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: typeof Users;
  accent: 'sky' | 'amber' | 'emerald';
}) {
  const colors = {
    sky: 'text-sky-300 bg-sky-500/10 border-sky-400/20',
    amber: 'text-amber-300 bg-amber-500/10 border-amber-400/20',
    emerald: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
  };
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div>
          <div className="text-xs text-white/55 uppercase tracking-wider">{label}</div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <div className={`h-10 w-10 rounded-md border flex items-center justify-center ${colors[accent]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function LoanRow({ loan }: { loan: LoanApplication }) {
  return (
    <li className="flex items-center justify-between py-2 text-sm">
      <div className="min-w-0">
        <div className="font-mono text-white/85 truncate">{loan.number}</div>
        <div className="text-xs text-white/50">
          {loan.status} · {loan.termMonths}m · {loan.annualInterestRate}% APR
        </div>
      </div>
      <div className="text-right">
        <div className="font-medium">{formatMoney(Number(loan.principal))}</div>
        <div className="text-xs text-white/45">
          Tier {loan.tierAtApply ?? '—'} · score {loan.creditScoreAtApply ?? '—'}
        </div>
      </div>
    </li>
  );
}
