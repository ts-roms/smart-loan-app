import { loanBalance, runningBalances, type LoanBalance } from "@loan/loans";
import { Badge } from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { CalendarClock } from "lucide-react";

/**
 * One installment as the loan detail endpoint returns it. Decimal
 * columns arrive as strings from Prisma over the wire, so every
 * arithmetic site coerces with Number() rather than trusting the type.
 */
export interface LedgerRow {
  id: string;
  installmentNo: number;
  dueDate: string;
  principalDue: string | number;
  interestDue: string | number;
  totalDue: string | number;
  principalPaid: string | number;
  interestPaid: string | number;
  paidInFullAt: string | null;
}

type RowState = "PAID" | "PARTIAL" | "OVERDUE" | "DUE";

/**
 * State of a single installment.
 *
 * `paidInFullAt` is authoritative for PAID — the repository sets it
 * only once principal AND interest are both covered, so deriving it
 * from the amounts here would just be a second, driftable copy of that
 * rule.
 *
 * Lateness outranks partial payment, deliberately. Checking PARTIAL
 * first meant an installment 90 days late with ₱100 against it read
 * "Partial" and looked handled — the delinquency, which is the thing
 * an officer or collector is scanning for, disappeared behind a part
 * payment. Anything past due and not settled in full is OVERDUE; the
 * Paid column still shows what came in, so nothing is lost.
 */
function stateOf(row: LedgerRow, today: number): RowState {
  if (row.paidInFullAt) return "PAID";
  if (new Date(row.dueDate).getTime() < today) return "OVERDUE";
  const paid = Number(row.principalPaid) + Number(row.interestPaid);
  return paid > 0 ? "PARTIAL" : "DUE";
}

const STATE_LABEL: Record<RowState, string> = {
  PAID: "Paid",
  PARTIAL: "Partial",
  OVERDUE: "Overdue",
  DUE: "Due",
};

const STATE_VARIANT: Record<
  RowState,
  "success" | "warning" | "danger" | "muted"
> = {
  PAID: "success",
  PARTIAL: "warning",
  OVERDUE: "danger",
  DUE: "muted",
};

/**
 * Sum the ledger.
 *
 * A thin re-export of `loanBalance` from @loan/loans, kept under the old
 * name because the feature's public API exports it. The arithmetic moved
 * to the shared lib when the API started computing the same figure for
 * the loans lists and the borrower's dashboard — three surfaces quoting
 * a balance from three implementations is how they drift.
 */
export const ledgerTotals = loanBalance;
export type LoanLedgerTotals = LoanBalance;

/**
 * Amortization ledger for one loan.
 *
 * The schedule already drove payment allocation, penalty accrual and
 * the collections queue, but it was never shown on screen — an officer
 * could see money received (PaymentsPanel) with nothing to read it
 * against. This is the other half: what was owed, when, and how much
 * of each installment has actually been settled.
 *
 * Two balance columns, because "what do I owe" has two honest answers:
 *
 *   • **Scheduled** — the contractual principal still outstanding after
 *     each installment, assuming every one before it was paid on time.
 *     What an amortization table conventionally means, and what "how
 *     much will I still owe after March?" is asking.
 *   • **Actual** — the same figure given what has really been paid.
 *     Below the scheduled line when the borrower is ahead, and flat
 *     from the point payments stopped when they're behind.
 *
 * Showing only the scheduled column, as this did originally, meant a
 * borrower four installments in arrears watched a balance march
 * confidently down as though nothing were wrong. Showing only the
 * actual one would lose the contractual reference they agreed to. Both
 * columns, side by side, is the comparison.
 */
export function LoanLedgerPanel({
  rows,
  principal,
}: {
  rows: LedgerRow[];
  principal: string | number;
}) {
  // Renders nothing rather than an empty table. Installments only exist
  // from disbursement onward, so every pre-disbursement loan — and every
  // rejected one — hits this. Deciding it here means callers don't each
  // repeat the guard and can't disagree about it.
  if (rows.length === 0) return null;

  const today = Date.now();
  const totals = ledgerTotals(rows);
  // Both running columns, computed by the same lib the API and the PDF
  // use. Parallel to `rows` — index i belongs to rows[i].
  const balances = runningBalances(rows, principal);

  return (
    <div className="border-t border-default pt-3">
      <SectionHeading count={rows.length} />

      <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Total label="Scheduled" value={totals.scheduled} />
        <Total label="Paid to date" value={totals.paid} />
        <Total label="Outstanding" value={totals.outstanding} emphasis />
        <div>
          <dt className="text-xs uppercase tracking-wider text-fg-subtle">
            Installments
          </dt>
          <dd className="font-mono text-sm">
            {totals.paidInstallments} / {rows.length}
          </dd>
        </div>
      </dl>

      {/*
        Nine columns don't fit a phone. Scroll the table inside its own
        box rather than letting it widen the page — the loan detail page
        is already dense and a sideways-panning card is worse than a
        sideways-scrolling table.
      */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[50rem] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="py-1 px-2">#</th>
              <th className="py-1 px-2">Due</th>
              <th className="py-1 px-2 text-right">Principal</th>
              <th className="py-1 px-2 text-right">Interest</th>
              <th className="py-1 px-2 text-right">Total</th>
              <th className="py-1 px-2 text-right">Paid</th>
              <th className="py-1 px-2 text-right">Scheduled bal.</th>
              <th className="py-1 px-2 text-right">Actual bal.</th>
              <th className="py-1 px-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {rows.map((r, i) => {
              const state = stateOf(r, today);
              const paid = Number(r.principalPaid) + Number(r.interestPaid);
              const running = balances[i]!;
              // Colour only where the comparison means something.
              // `actual < scheduled` is genuine prepayment at any row.
              // `actual > scheduled` is only evidence of arrears on rows
              // whose due date has passed — on FUTURE rows it just means
              // "not prepaid yet", which is every healthy loan, and a
              // red column down the whole future schedule right after an
              // on-time payment would read as delinquency where there is
              // none.
              const pastDue = new Date(r.dueDate).getTime() < today;
              const ahead = running.actualBalance < running.scheduledBalance;
              const behind =
                pastDue && running.actualBalance > running.scheduledBalance;
              return (
                <tr key={r.id} className="hover:bg-hover">
                  <td className="py-1.5 px-2 font-mono text-xs">
                    {r.installmentNo}
                  </td>
                  <td className="py-1.5 px-2 text-xs">
                    {formatDate(r.dueDate)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-xs">
                    {formatMoney(Number(r.principalDue))}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-xs">
                    {formatMoney(Number(r.interestDue))}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">
                    {formatMoney(Number(r.totalDue))}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-xs">
                    {paid > 0 ? formatMoney(paid) : "—"}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-xs text-fg-muted">
                    {formatMoney(running.scheduledBalance)}
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right font-mono text-xs ${
                      behind
                        ? "text-danger"
                        : ahead
                          ? "text-success"
                          : "text-fg"
                    }`}
                    title={
                      behind
                        ? "Above the contractual balance — payments are behind schedule"
                        : ahead
                          ? "Below the contractual balance — paid ahead of schedule"
                          : undefined
                    }
                  >
                    {formatMoney(running.actualBalance)}
                  </td>
                  <td className="py-1.5 px-2">
                    <Badge variant={STATE_VARIANT[state]}>
                      {STATE_LABEL[state]}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionHeading({ count }: { count: number }) {
  return (
    <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center gap-1">
      <CalendarClock className="h-3 w-3" />
      Amortization ledger ({count})
    </div>
  );
}

function Total({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-fg-subtle">
        {label}
      </dt>
      <dd
        className={
          emphasis ? "font-mono text-sm font-medium" : "font-mono text-sm"
        }
      >
        {formatMoney(value)}
      </dd>
    </div>
  );
}
