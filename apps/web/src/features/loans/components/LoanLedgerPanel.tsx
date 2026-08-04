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

export interface LoanLedgerTotals {
  scheduled: number;
  paid: number;
  outstanding: number;
  paidInstallments: number;
}

/**
 * Sum the ledger. Exported alongside the panel because the portal
 * summary and the staff panel must agree to the centavo — computing it
 * twice is how they drift.
 */
export function ledgerTotals(rows: LedgerRow[]): LoanLedgerTotals {
  let scheduled = 0;
  let paid = 0;
  let paidInstallments = 0;
  for (const r of rows) {
    scheduled += Number(r.totalDue);
    paid += Number(r.principalPaid) + Number(r.interestPaid);
    if (r.paidInFullAt) paidInstallments += 1;
  }
  return {
    scheduled,
    paid,
    // Guard the float dust: summing 12 two-decimal strings can land a
    // few millionths below zero on a fully paid loan, which would
    // render as "-0.00".
    outstanding: Math.max(0, scheduled - paid),
    paidInstallments,
  };
}

/**
 * Amortization ledger for one loan.
 *
 * The schedule already drove payment allocation, penalty accrual and
 * the collections queue, but it was never shown on screen — an officer
 * could see money received (PaymentsPanel) with nothing to read it
 * against. This is the other half: what was owed, when, and how much
 * of each installment has actually been settled.
 *
 * The "Balance" column is the SCHEDULED principal still outstanding
 * after each installment, which is what an amortization table
 * conventionally means and what a borrower asking "how much do I still
 * owe after March?" is asking. It deliberately doesn't react to early
 * or partial payments — the per-row Paid/Remaining columns and the
 * summary above carry the actual position.
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

  // Running scheduled principal, opening at the disbursed amount.
  let balance = Number(principal);

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
        Eight columns don't fit a phone. Scroll the table inside its own
        box rather than letting it widen the page — the loan detail page
        is already dense and a sideways-panning card is worse than a
        sideways-scrolling table.
      */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="py-1 px-2">#</th>
              <th className="py-1 px-2">Due</th>
              <th className="py-1 px-2 text-right">Principal</th>
              <th className="py-1 px-2 text-right">Interest</th>
              <th className="py-1 px-2 text-right">Total</th>
              <th className="py-1 px-2 text-right">Paid</th>
              <th className="py-1 px-2 text-right">Balance</th>
              <th className="py-1 px-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {rows.map((r) => {
              const state = stateOf(r, today);
              const paid = Number(r.principalPaid) + Number(r.interestPaid);
              balance -= Number(r.principalDue);
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
                    {/* Rounding dust again: the final row's scheduled
                        balance lands a hair off zero. */}
                    {formatMoney(Math.max(0, balance))}
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
