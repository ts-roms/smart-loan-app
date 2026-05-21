import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { CreditCard, FileEdit, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { LoanStatusBadge } from "../components/StatusBadge";
import { QuickLoanLink } from "../components/QuickLoanDrawer";
import { TYPE_LABELS } from "../constants";
import { useLoanDrafts, useLoans } from "../hooks";
import { findArticle, TourButton } from "../../help";

/**
 * Loan list page. Renders the master table and hosts the "new loan"
 * dialog. The dialog itself is product-aware and self-contained — see
 * `components/NewLoanDialog.tsx`.
 */
export function LoansListPage() {
  const loans = useLoans();
  const drafts = useLoanDrafts();
  const navigate = useNavigate();

  const tourSteps = findArticle("loans-list")?.tour ?? [];
  const draftCount = drafts.data?.length ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          Loans
        </CardTitle>
        <div className="flex items-center gap-2">
          <TourButton tourId="loans-list" steps={tourSteps} />
          {draftCount > 0 && (
            <Button
              variant="outline"
              onClick={() => navigate("/loans/drafts")}
              title={`${draftCount} saved draft${draftCount === 1 ? "" : "s"}`}
            >
              <FileEdit className="h-4 w-4" />
              Drafts ({draftCount})
            </Button>
          )}
          <Button onClick={() => navigate("/loans/new")} data-tour="loans-new">
            <Plus className="h-4 w-4" />
            New application
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loans.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
          </div>
        ) : (loans.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No loans yet.</p>
        ) : (
          <table className="w-full text-sm" data-tour="loans-table">
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
                    <QuickLoanLink id={l.id}>{l.number}</QuickLoanLink>
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1">
                      <Badge variant="muted">
                        {TYPE_LABELS[l.productCode] ?? l.productCode}
                      </Badge>
                      {l.isRepeat && (
                        <Badge variant="success" title="Repeat borrower">
                          Repeat
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    {formatMoney(Number(l.principal))}
                  </td>
                  <td className="py-2 px-2">{l.termMonths}m</td>
                  <td className="py-2 px-2">
                    {(Number(l.annualInterestRate) * 100).toFixed(2)}%
                  </td>
                  <td className="py-2 px-2">
                    <LoanStatusBadge status={l.status} />
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
