import { usePortalLoans } from '@loan/api-client';
import { Badge, Card, CardContent, CardHeader, CardTitle, SkeletonCard } from '@loan/ui';
import { formatDate, formatMoney } from '@loan/shared-utils';
import { Link } from 'react-router-dom';

const TYPE_LABEL: Record<string, string> = {
  SALARY: 'Salary',
  AUTOMOTIVE: 'Auto',
  MOTORCYCLE: 'Motorcycle',
  HOUSING: 'Housing',
};

export function PortalLoans() {
  const loans = usePortalLoans();

  return (
    <Card>
      <CardHeader>
        <CardTitle>My loans</CardTitle>
      </CardHeader>
      <CardContent>
        {loans.isLoading ? (
          <SkeletonCard />
        ) : (loans.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">
            No loans yet.{' '}
            <Link to="/portal/apply" className="text-sky-300 hover:underline">
              Apply now →
            </Link>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Number</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Principal</th>
                <th className="py-2 px-2">Term</th>
                <th className="py-2 px-2">Rate</th>
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
                  <td className="py-2 px-2">{l.termMonths}m</td>
                  <td className="py-2 px-2">
                    {(Number(l.annualInterestRate) * 100).toFixed(2)}%
                  </td>
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
  );
}

function badgeVariant(status: string): 'success' | 'danger' | 'muted' | 'warning' {
  if (['APPROVED', 'DISBURSED', 'ACTIVE'].includes(status)) return 'success';
  if (['REJECTED', 'DEFAULTED', 'CANCELLED'].includes(status)) return 'danger';
  if (status === 'CLOSED') return 'muted';
  return 'warning';
}
