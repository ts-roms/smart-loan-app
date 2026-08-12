import { useCustomerExposure } from "@loan/api-client";
import type { CustomerExposure, ExposureLoanLine } from "@loan/shared-types";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  cn,
} from "@loan/ui";
import { AlertTriangle, Layers, Scale, Wallet } from "lucide-react";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "../../loans/components/StatusBadge";
import { StatTile } from "./StatTile";

/**
 * What this borrower owes us — all of it, in one number.
 *
 * The Loans panel above answers "what have they borrowed"; this answers
 * "what are we into them for", which is a different question and the one
 * that decides whether they get a fifth loan. Read off the loan list by
 * eye it is an addition an officer does in their head, under time
 * pressure, on a table that includes rejected applications and a loan
 * that was restructured into another one on the same page. That sum is
 * wrong often enough to matter.
 *
 * Deliberately sits directly under the loans table: the totals here are
 * a fold of those rows, and putting them apart invites reading them as
 * two unrelated figures.
 */
export function CustomerExposurePanel({
  idOrNumber,
}: {
  idOrNumber: string | null;
}) {
  const exposure = useCustomerExposure(idOrNumber);

  if (exposure.isLoading) return <SkeletonCard />;
  if (!exposure.data) return null;

  const data = exposure.data;
  const counted = data.loans.filter((l) => l.counted);
  const excluded = data.loans.filter((l) => !l.counted);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4" />
            Consolidated exposure
          </CardTitle>
          {/*
            Arrears are only meaningful relative to an instant, and a
            panel screenshotted into a credit file without one can't be
            reconciled afterwards.
          */}
          <div className="text-[10px] text-fg-subtle mt-1">
            As of {formatDateTime(data.asOf)}
          </div>
        </div>
        {data.total.pastDue > 0 && (
          <Badge variant="danger">
            {formatMoney(data.total.pastDue)} past due
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <StatTile
            label="Total exposure"
            value={formatMoney(data.total.principalOutstanding)}
            accent={data.total.principalOutstanding > 0 ? "warning" : "success"}
            icon={Wallet}
            sub="Principal outstanding"
          />
          <StatTile
            label="Incl. interest"
            value={formatMoney(data.total.outstanding)}
            accent="info"
            icon={Scale}
            sub="Principal + scheduled interest"
          />
          <StatTile
            label="Past due"
            value={formatMoney(data.total.pastDue)}
            accent={data.total.pastDue > 0 ? "danger" : "success"}
            icon={AlertTriangle}
            sub={
              data.total.pastDue > 0
                ? "Unpaid instalments already due"
                : "Nothing in arrears"
            }
          />
          <StatTile
            label="Active loans"
            value={String(data.total.activeLoans)}
            accent={data.total.activeLoans > 0 ? "primary" : "muted"}
            icon={Layers}
            sub={
              excluded.length > 0
                ? `${excluded.length} not counted`
                : "Every loan counted"
            }
          />
        </div>

        {/*
          A write-off is off the receivable — the loss was already
          expensed to Bad Debt — so it is not in the total above. It is
          also the single most important thing to know about the person
          in front of you, and leaving it only as a row in a table an
          officer may not scroll to is how they get lent to again.
        */}
        {data.excluded.writtenOffLoans > 0 && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {data.excluded.writtenOffLoans === 1
              ? "One loan was written off"
              : `${data.excluded.writtenOffLoans} loans were written off`}{" "}
            for {formatMoney(data.excluded.writtenOffPrincipal)} of principal.
            Not included in the exposure above — the loss is already booked to
            Bad Debt — but it is history this borrower carries.
          </div>
        )}

        {counted.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No live exposure. This customer has nothing outstanding right now.
          </p>
        ) : (
          <ExposureTable rows={counted} total={data.total} />
        )}

        {excluded.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-fg-muted hover:text-fg">
              {excluded.length} loan{excluded.length === 1 ? "" : "s"} not
              counted
            </summary>
            {/*
              Listed rather than dropped, and with the reason attached:
              "why isn't this ₱250,000 loan in the total" is the first
              question anyone asks of a consolidated figure, and it has
              to be answerable without reading the source.
            */}
            <ul className="mt-2 divide-y divide-default">
              {excluded.map((l) => (
                <li
                  key={l.loanId}
                  className="flex items-center gap-2 py-1.5 justify-between"
                >
                  <Link
                    to={`/loans/${l.loanNumber}`}
                    className="tabular text-primary hover:underline"
                  >
                    {l.loanNumber}
                  </Link>
                  <span className="flex-1 text-fg-subtle truncate">
                    {excludedReason(l)}
                  </span>
                  <span className="tabular text-fg-muted">
                    {formatMoney(l.principal)}
                  </span>
                  <LoanStatusBadge status={l.status} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function ExposureTable({
  rows,
  total,
}: {
  rows: ExposureLoanLine[];
  total: CustomerExposure["total"];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2 font-medium">Loan</th>
            <th className="py-2 px-2 font-medium">Product</th>
            <th className="py-2 px-2 font-medium text-right">Principal</th>
            <th className="py-2 px-2 font-medium text-right">Outstanding</th>
            <th className="py-2 px-2 font-medium text-right">Past due</th>
            <th className="py-2 px-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {rows.map((l) => (
            <tr key={l.loanId} className="hover:bg-hover">
              <td className="py-2 px-2">
                <Link
                  to={`/loans/${l.loanNumber}`}
                  className="tabular text-primary hover:underline"
                >
                  {l.loanNumber}
                </Link>
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted">
                {l.productName ?? l.productCode}
              </td>
              <td className="py-2 px-2 text-right tabular">
                {formatMoney(l.principal)}
              </td>
              <td className="py-2 px-2 text-right tabular">
                {formatMoney(l.principalOutstanding)}
                {/*
                  An approved loan has no schedule yet, so its figure is
                  the amount committed rather than a balance drawn. The
                  two are not the same claim and the column would
                  otherwise present them as if they were.
                */}
                {!l.fromSchedule && (
                  <div className="text-[10px] text-fg-subtle">committed</div>
                )}
              </td>
              <td
                className={cn(
                  "py-2 px-2 text-right tabular",
                  l.pastDue > 0 && "text-danger",
                )}
              >
                {l.pastDue > 0 ? (
                  <>
                    {formatMoney(l.pastDue)}
                    <div className="text-[10px] text-fg-subtle">
                      {l.overdueInstallments}{" "}
                      {l.overdueInstallments === 1
                        ? "instalment"
                        : "instalments"}
                    </div>
                  </>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </td>
              <td className="py-2 px-2">
                <LoanStatusBadge status={l.status} />
              </td>
            </tr>
          ))}
        </tbody>
        {/*
          The visible rows add to the visible total, because the server
          rounds each row before summing them. A footer that didn't
          reconcile would discredit every figure above it.
        */}
        <tfoot>
          <tr className="border-t-2 border-default font-semibold">
            <td className="py-2 px-2" colSpan={3}>
              Total exposure
            </td>
            <td className="py-2 px-2 text-right tabular">
              {formatMoney(total.principalOutstanding)}
            </td>
            <td
              className={cn(
                "py-2 px-2 text-right tabular",
                total.pastDue > 0 && "text-danger",
              )}
            >
              {total.pastDue > 0 ? formatMoney(total.pastDue) : "—"}
            </td>
            <td className="py-2 px-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Why a row sits outside the total. Phrased for an officer, not a dev. */
function excludedReason(loan: ExposureLoanLine): string {
  switch (loan.status) {
    case "CLOSED":
      return "Repaid in full";
    case "WRITTEN_OFF":
      return "Written off to Bad Debt";
    case "RESTRUCTURED":
      return "Replaced by a restructured loan";
    case "REJECTED":
      return "Declined";
    case "CANCELLED":
      return "Cancelled before approval";
    default:
      return "Not yet granted";
  }
}
