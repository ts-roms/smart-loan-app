import { usePortalLoans } from "@loan/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { Link } from "react-router-dom";

// Pulled from features/loans so the borrower portal renders products
// with the same short label as the officer console — one source of
// truth instead of three diverging copies.
import { LOAN_TYPE_LABELS } from "../../loans";

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
          <p className="text-sm text-fg-muted">
            No loans yet.{" "}
            <Link to="/portal/apply" className="text-info hover:underline">
              Apply now →
            </Link>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Number</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Principal</th>
                {/* What was borrowed and what's left are different
                    questions, and the second is the one a borrower opens
                    this page to answer. */}
                <th className="py-2 px-2">Balance</th>
                <th className="py-2 px-2">Term</th>
                <th className="py-2 px-2">Rate</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(loans.data ?? []).map((l) => (
                <tr key={l.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">
                    <Link
                      to={`/portal/loans/${l.number}`}
                      className="text-info hover:underline"
                    >
                      {l.number}
                    </Link>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">
                      {LOAN_TYPE_LABELS[l.productCode] ?? l.productCode}
                    </Badge>
                  </td>
                  <td className="py-2 px-2">
                    {formatMoney(Number(l.principal))}
                  </td>
                  {/* An em dash, not ₱0.00, when there's no schedule yet:
                      a pending loan has nothing to pay *yet*, which is
                      not the same as nothing left to pay. */}
                  <td className="py-2 px-2 font-medium">
                    {l.balance ? formatMoney(l.balance.outstanding) : "—"}
                  </td>
                  <td className="py-2 px-2">{l.termMonths}m</td>
                  <td className="py-2 px-2">
                    {(Number(l.annualInterestRate) * 100).toFixed(2)}%
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={badgeVariant(l.status)}>{l.status}</Badge>
                  </td>
                  <td className="py-2 px-2 text-xs text-fg-muted">
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

function badgeVariant(
  status: string,
): "success" | "danger" | "muted" | "warning" {
  if (["APPROVED", "DISBURSED", "ACTIVE"].includes(status)) return "success";
  if (["REJECTED", "DEFAULTED", "CANCELLED"].includes(status)) return "danger";
  if (status === "CLOSED") return "muted";
  return "warning";
}
