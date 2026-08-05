import { formatMoney } from "@loan/shared-utils";
import { SkeletonLine } from "@loan/ui";
import { CalendarClock, Info } from "lucide-react";
import { useEffect } from "react";

import { useQuote } from "../hooks";

/**
 * Amortization *projection* for a loan that has no schedule yet.
 *
 * Instalment rows are written at disbursement, so between approval and
 * release there is nothing for {@link LoanLedgerPanel} to render and it
 * correctly draws nothing. That left the borrower on the page where they
 * most want the answer — "what will I actually be paying?" — with the
 * principal, the term and a rate, and no figures.
 *
 * This fills that window and only that window. It computes from
 * POST /loans/quote, the same endpoint the apply wizard prices with, so
 * the numbers shown here are the ones the loan will be booked at.
 *
 * Two things it deliberately does NOT do:
 *
 *   • It has no paid / status columns. Nothing has been paid, and
 *     rendering an empty "Status" column invites the reading that
 *     something is due.
 *   • It doesn't show dates. Instalment dates key off the disbursement
 *     date, which by definition hasn't happened — inventing them from
 *     today would put a due date on the page that the real schedule
 *     then contradicts.
 */
export function ProjectedSchedulePanel({
  principal,
  termMonths,
  annualInterestRate,
  productCode,
}: {
  principal: string | number;
  termMonths: number;
  /** Annual rate as a decimal (0.24 = 24% APR), as the loan stores it. */
  annualInterestRate: string | number;
  productCode: string;
}) {
  const quote = useQuote();
  const p = Number(principal);
  const rate = Number(annualInterestRate);

  // One shot per loan — unlike the wizard's live preview there's no form
  // being edited here, so this fires on mount and when the loan's own
  // terms change (a restructure, say), and not otherwise.
  useEffect(() => {
    if (p > 0 && termMonths > 0) {
      quote.mutate({
        principal: p,
        termMonths,
        annualInterestRate: rate,
        productCode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, termMonths, rate, productCode]);

  if (quote.isPending) {
    return (
      <div className="border-t border-default pt-3 space-y-2">
        <SectionHeading />
        <SkeletonLine />
        <SkeletonLine />
      </div>
    );
  }

  // Silent on failure. This is supplementary — a borrower who can't see
  // a projection is no worse off than before it existed, and an error
  // banner on an otherwise healthy loan page would read as a problem
  // with the loan.
  const rows = quote.data?.schedule ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-default pt-3">
      <SectionHeading />

      <div className="mb-3 flex items-start gap-1.5 rounded border border-default bg-surface-2 px-2 py-1.5 text-[11px] text-fg-muted">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          Estimate. Your actual schedule is generated when the loan is released,
          and instalment dates are set from the release date.
        </span>
      </div>

      <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Total label="Per instalment" value={quote.data?.monthlyPayment ?? 0} />
        <Total label="Total interest" value={quote.data?.totalInterest ?? 0} />
        <Total label="Total payable" value={quote.data?.totalPaid ?? 0} />
        <div>
          <dt className="text-xs uppercase tracking-wider text-fg-subtle">
            Instalments
          </dt>
          <dd className="font-mono text-sm">{rows.length}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="py-1 px-2">#</th>
              <th className="py-1 px-2 text-right">Principal</th>
              <th className="py-1 px-2 text-right">Interest</th>
              <th className="py-1 px-2 text-right">Payment</th>
              <th className="py-1 px-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {rows.map((r) => (
              <tr key={r.installmentNo} className="hover:bg-hover">
                <td className="py-1.5 px-2 font-mono text-xs">
                  {r.installmentNo}
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-xs">
                  {formatMoney(r.principal)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-xs">
                  {formatMoney(r.interest)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {formatMoney(r.payment)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-xs text-fg-muted">
                  {formatMoney(Math.max(0, r.balance))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionHeading() {
  return (
    <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center gap-1">
      <CalendarClock className="h-3 w-3" />
      Projected amortization
    </div>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-fg-subtle">
        {label}
      </dt>
      <dd className="font-mono text-sm">{formatMoney(value)}</dd>
    </div>
  );
}
