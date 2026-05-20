import { useBankStatements } from '@loan/api-client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from '@loan/ui';
import { formatDate, formatDateTime, formatMoney } from '@loan/shared-utils';
import { Banknote, FileSpreadsheet, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../../../providers/auth';
import { ImportStatementDialog } from '../components/ImportStatementDialog';

/**
 * Bank reconciliation landing — list of imported statements and an
 * "Import" button. Click any row to open its detail view where lines can
 * be matched.
 */
export function BankStatementsPage() {
  const list = useBankStatements();
  const { user } = useAuth();
  const canImport = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT';
  const [importing, setImporting] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-sky-300" />
          Bank reconciliation
        </CardTitle>
        {canImport && (
          <Button onClick={() => setImporting(true)}>
            <Plus className="h-4 w-4" />
            Import statement
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-xs text-white/55 mb-3">
          Imported bank statements. Each statement holds raw transaction
          lines; auto-match pairs incoming credits with recorded payments
          and outgoing debits with loan disbursements. Anything that
          doesn't match automatically stays unreconciled until a human
          attaches it manually.
        </p>
        {list.isLoading ? (
          <SkeletonCard />
        ) : (list.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">
            No statements imported yet. Click <strong>Import statement</strong> to
            start the first reconciliation.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Label</th>
                <th className="py-2 px-2">Account</th>
                <th className="py-2 px-2">Period</th>
                <th className="py-2 px-2 text-right">Opening</th>
                <th className="py-2 px-2 text-right">Closing</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Imported</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(list.data ?? []).map((s) => (
                <tr key={s.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2">
                    <Link
                      to={`/reconciliation/${s.id}`}
                      className="text-sky-300 hover:underline font-medium"
                    >
                      {s.label}
                    </Link>
                  </td>
                  <td className="py-2 px-2 font-mono text-xs">{s.bankAccount}</td>
                  <td className="py-2 px-2 text-xs">
                    {formatDate(s.periodStart)} → {formatDate(s.periodEnd)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {formatMoney(Number(s.openingBalance))}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {formatMoney(Number(s.closingBalance))}
                  </td>
                  <td className="py-2 px-2">
                    <Badge
                      variant={
                        s.status === 'RECONCILED'
                          ? 'success'
                          : s.status === 'ARCHIVED'
                            ? 'muted'
                            : 'muted'
                      }
                    >
                      {s.status}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-xs text-white/55">
                    <FileSpreadsheet className="h-3 w-3 inline mr-1" />
                    {formatDateTime(s.importedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {importing && <ImportStatementDialog onClose={() => setImporting(false)} />}
    </Card>
  );
}
