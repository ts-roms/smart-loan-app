import { usePortalKyc, usePortalLoans, usePortalMe } from '@loan/api-client';
import { Badge, Card, CardContent, CardHeader, CardTitle, SkeletonCard } from '@loan/ui';
import { formatDate, formatMoney } from '@loan/shared-utils';
import { CreditCard, FileCheck2, Gauge } from 'lucide-react';
import { Link } from 'react-router-dom';

const TYPE_LABEL: Record<string, string> = {
  SALARY: 'Salary',
  AUTOMOTIVE: 'Auto',
  MOTORCYCLE: 'Motorcycle',
  HOUSING: 'Housing',
};

export function PortalDashboard() {
  const me = usePortalMe();
  const loans = usePortalLoans();
  const kyc = usePortalKyc();

  if (me.isLoading || loans.isLoading) return <SkeletonCard />;

  const active = (loans.data ?? []).filter((l) =>
    ['DISBURSED', 'ACTIVE'].includes(l.status),
  );
  const outstanding = active.reduce((sum, l) => sum + Number(l.principal), 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          Hello, {me.data?.customer.firstName} 👋
        </h1>
        <p className="text-sm text-white/55">
          {kyc.data?.status.complete
            ? 'Your account is verified. You can apply for new loans.'
            : 'Please complete your KYC documents to unlock new loans.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat label="Active loans" icon={CreditCard} value={String(active.length)} />
        <Stat label="Outstanding" icon={Gauge} value={formatMoney(outstanding)} />
        <Stat
          label="KYC status"
          icon={FileCheck2}
          value={kyc.data?.status.status ?? 'NONE'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>My loans</CardTitle>
        </CardHeader>
        <CardContent>
          {(loans.data ?? []).length === 0 ? (
            <p className="text-sm text-white/55">
              You don't have any loans yet.{' '}
              <Link to="/portal/apply" className="text-sky-300 hover:underline">
                Apply for one →
              </Link>
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Number</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Principal</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(loans.data ?? []).map((l) => (
                  <tr key={l.id} className="hover:bg-white/[0.03]">
                    <td className="py-2 px-2 font-mono">
                      <Link
                        to={`/portal/loans/${l.id}`}
                        className="text-sky-300 hover:underline"
                      >
                        {l.number}
                      </Link>
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant="muted">{TYPE_LABEL[l.productCode] ?? l.productCode}</Badge>
                    </td>
                    <td className="py-2 px-2">{formatMoney(Number(l.principal))}</td>
                    <td className="py-2 px-2">
                      <Badge variant={badgeVariant(l.status)}>{l.status}</Badge>
                    </td>
                    <td className="py-2 px-2 text-xs text-white/55">
                      {formatDate(l.submittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function badgeVariant(status: string): 'success' | 'danger' | 'muted' | 'warning' {
  if (['APPROVED', 'DISBURSED', 'ACTIVE'].includes(status)) return 'success';
  if (['REJECTED', 'DEFAULTED', 'CANCELLED'].includes(status)) return 'danger';
  if (status === 'CLOSED') return 'muted';
  return 'warning';
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof CreditCard;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div>
          <div className="text-xs text-white/55 uppercase tracking-wider">{label}</div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <Icon className="h-8 w-8 text-sky-300 opacity-60" />
      </CardContent>
    </Card>
  );
}
