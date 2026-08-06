import { useLoans } from "@loan/api-client";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { CreditCard } from "lucide-react";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "../../loans/components/StatusBadge";

/**
 * This borrower's loan history.
 *
 * "What have they borrowed before, and how did it go" is the question
 * an officer asks before lending again, and until now the only way to
 * answer it was to search the global loan list by name and hope the
 * spelling matched. It belongs on the profile.
 *
 * Every status, not just the live ones. A closed loan repaid on time is
 * the single best thing you can know about an applicant, and a written-
 * off one is the single worst — filtering to "current" would hide
 * exactly the rows that carry the most information.
 */
export function CustomerLoansPanel({ customerId }: { customerId: string }) {
  const loans = useLoans({ customerId, pageSize: 50 });
  const rows = loans.data ?? [];

  if (loans.isLoading) return <SkeletonCard />;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CreditCard className="h-4 w-4" />
          Loans
        </CardTitle>
        {rows.length > 0 && (
          <Badge variant="muted">
            {rows.length} {rows.length === 1 ? "loan" : "loans"}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No loans yet. This customer has never borrowed.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2 font-medium">Loan</th>
                  <th className="py-2 px-2 font-medium">Product</th>
                  <th className="py-2 px-2 font-medium text-right">
                    Principal
                  </th>
                  <th className="py-2 px-2 font-medium text-right">
                    Outstanding
                  </th>
                  <th className="py-2 px-2 font-medium">Status</th>
                  <th className="py-2 px-2 font-medium">Applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {rows.map((l) => (
                  <tr key={l.id} className="hover:bg-hover">
                    <td className="py-2 px-2">
                      <Link
                        to={`/loans/${l.number}`}
                        className="tabular text-primary hover:underline"
                      >
                        {l.number}
                      </Link>
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {l.productCode}
                    </td>
                    <td className="py-2 px-2 text-right tabular">
                      {formatMoney(Number(l.principal))}
                    </td>
                    <td className="py-2 px-2 text-right tabular">
                      {/*
                        A dash, not ₱0.00, where there is no balance.
                        `balance` is null until a schedule exists, and
                        printing zero for a rejected or undisbursed loan
                        would read as "fully repaid" — the opposite of
                        the truth, on the column an officer scans first.
                      */}
                      {l.balance ? (
                        formatMoney(l.balance.outstanding)
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <LoanStatusBadge status={l.status} />
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDate(l.submittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
