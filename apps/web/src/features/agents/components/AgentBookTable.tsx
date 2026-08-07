import type { AgentBookLoan } from "@loan/shared-types";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { Badge } from "@loan/ui";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "../../loans/components/StatusBadge";

/**
 * One agent's assisted loans.
 *
 * Every status, including rejected. An agent needs to know which of
 * their applications died as much as which paid — a table that only
 * showed the wins would leave them guessing why a number moved.
 *
 * The commission column distinguishes three states rather than two,
 * because "we owe you this" and "we've booked this" are different
 * promises and an agent chasing a payment needs to tell them apart.
 */
export function AgentBookTable({
  loans,
  /** Officers get borrower links; agents don't hold `customers.read`. */
  linkCustomers = false,
  linkLoans = false,
}: {
  loans: AgentBookLoan[];
  linkCustomers?: boolean;
  linkLoans?: boolean;
}) {
  if (loans.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-fg-muted">
        No applications yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2 font-medium">Loan</th>
            <th className="py-2 px-2 font-medium">Borrower</th>
            <th className="py-2 px-2 font-medium">Product</th>
            <th className="py-2 px-2 font-medium text-right">Principal</th>
            <th className="py-2 px-2 font-medium text-right">Rate</th>
            <th className="py-2 px-2 font-medium text-right">Commission</th>
            <th className="py-2 px-2 font-medium">Status</th>
            <th className="py-2 px-2 font-medium">Applied</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {loans.map((l) => (
            <tr key={l.id} className="hover:bg-hover">
              <td className="py-2 px-2">
                {linkLoans ? (
                  <Link
                    to={`/loans/${l.number}`}
                    className="tabular text-primary hover:underline"
                  >
                    {l.number}
                  </Link>
                ) : (
                  <span className="tabular">{l.number}</span>
                )}
              </td>
              <td className="py-2 px-2 text-xs">
                {linkCustomers ? (
                  <Link
                    to={`/customers/${l.customerNumber}`}
                    className="text-primary hover:underline"
                  >
                    {l.customerName}
                  </Link>
                ) : (
                  l.customerName
                )}
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted">
                {l.productCode}
              </td>
              <td className="py-2 px-2 text-right tabular">
                {formatMoney(l.principal)}
              </td>
              <td className="py-2 px-2 text-right tabular text-xs text-fg-muted">
                {/*
                  A dash where no rate was frozen. Printing 0.00% would
                  claim a decision nobody made — these are rows assigned
                  before the product carried a rate at all.
                */}
                {l.commissionRate === null ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  `${(l.commissionRate * 100).toFixed(2)}%`
                )}
              </td>
              <td className="py-2 px-2 text-right">
                <CommissionCell loan={l} />
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
  );
}

function CommissionCell({ loan }: { loan: AgentBookLoan }) {
  if (loan.commissionAmount === null || loan.commissionAmount === 0) {
    return <span className="text-fg-subtle">—</span>;
  }
  const amount = formatMoney(loan.commissionAmount);
  if (loan.commissionPostedAt) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="tabular text-success">{amount}</span>
        <Badge variant="muted" title="Booked to the ledger at disbursement">
          booked
        </Badge>
      </span>
    );
  }
  return (
    <span
      className="tabular text-fg-muted"
      title="Not yet earned — this loan has not been disbursed"
    >
      {amount}
    </span>
  );
}
