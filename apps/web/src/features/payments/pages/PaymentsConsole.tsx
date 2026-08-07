import type {
  LoanApplication,
  LoanListQuery,
  LoanStatus,
} from "@loan/shared-types";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DatePicker,
  Input,
  Label,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { useLoansPage, useRecordPayment } from "@loan/api-client";
import { formatDate, formatMoney, todayLocalISO } from "@loan/shared-utils";
import { HandCoins, Search, Wallet, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useDebouncedValue } from "../../../lib/use-debounced-value";
// Cross-feature surfaces, imported the way collections does: the status
// badge and quick drawer from loans, the summary drawer from customers.
import { LoanStatusBadge } from "../../loans/components/StatusBadge";
import { QuickLoanLink } from "../../loans/components/QuickLoanDrawer";
import { LOAN_STATUS_OPTIONS } from "../../loans/constants";

/** Rows per page — cashier work is one borrower at a time, keep it tight. */
const PAGE_SIZE = 25;

/**
 * Statuses a payment can be recorded against. Mirrors PAYABLE_STATUSES
 * in LoanRepository (the API re-checks and 4xxes regardless) — CLOSED
 * and WRITTEN_OFF are deliberately included, because late recoveries on
 * finished loans are real money that still has to be booked.
 */
const PAYABLE = new Set<LoanStatus>([
  "DISBURSED",
  "ACTIVE",
  "DEFAULTED",
  "CLOSED",
  "WRITTEN_OFF",
]);

/**
 * Payments console — the cashier's counter.
 *
 * Recording a payment previously meant opening each loan's detail page,
 * or the bulk CSV import for batch work. Neither fits the counter case:
 * a borrower stands in front of the cashier, pays cash against one
 * loan, and the next borrower is behind them. This page is the middle
 * path — search the book, see the outstanding balance, record, next.
 *
 * Deliberately reuses the loans list endpoint (search + balances +
 * pagination) rather than growing a payments-specific one: the row a
 * cashier needs is exactly a loan row, and one list contract means the
 * balance shown here can't disagree with the loans page.
 *
 * Defaults to ACTIVE — the overwhelmingly common payable status — not
 * to a client-side "payable only" filter, which would fight the
 * server-side pagination counts. Rows in non-payable statuses still
 * render when the filter includes them; they just have no Record
 * button, with the status badge explaining why.
 */
export function PaymentsConsolePage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LoanStatus | "ALL">("ACTIVE");
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<LoanApplication | null>(null);

  const q = useDebouncedValue(search.trim()) || undefined;
  const filter: LoanListQuery = {
    q,
    status: status === "ALL" ? undefined : status,
    page,
    pageSize: PAGE_SIZE,
  };

  // Filter changes reshuffle the result set; the old page number stops
  // meaning anything. Same rule as the loans and customers lists.
  useEffect(() => {
    setPage(1);
  }, [q, status]);

  const loans = useLoansPage(filter);
  const rows = loans.data?.rows ?? [];
  const total = loans.data?.total ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4" />
          Payments
        </CardTitle>
        <Link
          to="/payments/bulk"
          className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-3 px-3 py-1.5 text-sm hover:bg-hover"
        >
          Bulk import
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle" />
            <Input
              className="pl-8"
              placeholder="Search loan number or borrower…"
              aria-label="Search loans"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as LoanStatus | "ALL")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {LOAN_STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(q || status !== "ACTIVE") && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setStatus("ACTIVE");
              }}
            >
              <X className="h-3.5 w-3.5" />
              Reset
            </Button>
          )}
          <span className="text-xs text-fg-muted ml-auto">
            {total} loan{total === 1 ? "" : "s"}
          </span>
        </div>

        {loans.isLoading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {q ? "No loans match that search." : "No loans in this status."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Number</th>
                <th className="py-2 px-2">Borrower</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2 text-right">Outstanding</th>
                <th className="py-2 px-2 text-right">Paid</th>
                <th className="py-2 px-2">Instalments</th>
                <th className="py-2 px-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {rows.map((l) => (
                <tr key={l.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">
                    <QuickLoanLink id={l.id}>{l.number}</QuickLoanLink>
                  </td>
                  <td className="py-2 px-2">
                    {l.customer ? (
                      <Link
                        to={`/customers/${l.customer.number}`}
                        className="text-info hover:underline"
                      >
                        {l.customer.firstName} {l.customer.lastName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <LoanStatusBadge status={l.status} />
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {l.balance ? formatMoney(l.balance.outstanding) : "—"}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-xs text-fg-muted">
                    {l.balance ? formatMoney(l.balance.paid) : "—"}
                  </td>
                  <td className="py-2 px-2 text-xs text-fg-muted">
                    {l.balance
                      ? `${l.balance.paidInstallments} / ${l.balance.totalInstallments}`
                      : "—"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {PAYABLE.has(l.status) && (
                      <Button size="sm" onClick={() => setPaying(l)}>
                        <HandCoins className="h-3.5 w-3.5" />
                        Record
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows.length > 0 && (
          <Pagination
            page={loans.data?.page ?? 1}
            totalPages={loans.data?.totalPages ?? 1}
            total={total}
            pageSize={loans.data?.pageSize ?? PAGE_SIZE}
            onPageChange={setPage}
            noun="loan"
            busy={loans.isFetching}
          />
        )}
      </CardContent>

      {paying && (
        <RecordPaymentDialog loan={paying} onClose={() => setPaying(null)} />
      )}
    </Card>
  );
}

/**
 * The per-loan payment form, lifted from the loan detail page's inline
 * version into a dialog so the cashier never leaves the queue. Amount +
 * OR reference; allocation (interest-first, oldest installment first)
 * is the repository's business, same as everywhere else.
 */
function RecordPaymentDialog({
  loan,
  onClose,
}: {
  loan: LoanApplication;
  onClose: () => void;
}) {
  const record = useRecordPayment();
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState("");
  /*
   * When the money was RECEIVED, not when it was keyed.
   *
   * `paidOn` flows through to `loanPaymentEntry`'s entryDate, so it
   * decides which accounting period the receipt lands in. Without it
   * every payment was stamped "now": cash taken at a branch on the 31st
   * and entered on the 1st booked into the following month, so the
   * accountant closed a period with that receipt missing from it.
   *
   * The endpoint and the bulk importer have accepted `paidOn` all
   * along — the CSV format documents it — and only this dialog, the one
   * a cashier actually uses, never sent it.
   */
  const [paidOn, setPaidOn] = useState(() => todayLocalISO());

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount <= 0) return;
    try {
      await record.mutateAsync({
        loanId: loan.id,
        amount,
        paidOn,
        reference: reference.trim() || undefined,
      });
      toast.success(`${formatMoney(amount)} recorded on ${loan.number}`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not record the payment");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="h-4 w-4" />
            Record payment · <span className="font-mono">{loan.number}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
                Borrower
              </div>
              {loan.customer
                ? `${loan.customer.firstName} ${loan.customer.lastName}`
                : "—"}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
                Outstanding
              </div>
              <span className="font-mono">
                {loan.balance ? formatMoney(loan.balance.outstanding) : "—"}
              </span>
            </div>
          </div>
          <form onSubmit={onSubmit} className="space-y-2">
            <Input
              type="number"
              min={1}
              step="0.01"
              placeholder="Amount (₱)"
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
              required
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Received on</Label>
                <DatePicker
                  value={paidOn}
                  onChange={setPaidOn}
                  // No future receipts — money cannot arrive tomorrow.
                  max={todayLocalISO()}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pay-ref">Reference / OR #</Label>
                <Input
                  id="pay-ref"
                  placeholder="Optional"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
            </div>
            {paidOn !== todayLocalISO() && (
              /*
                Named, because a backdated receipt can land in a period
                that is already closed or about to be, and the person
                keying it is the only one who knows it was deliberate.
              */
              <p className="text-xs text-fg-muted">
                Backdated — this books into the accounting period covering{" "}
                {formatDate(paidOn)}.
              </p>
            )}
            {loan.balance && amount > loan.balance.outstanding && (
              <p className="text-xs text-warning">
                Amount exceeds the outstanding balance — the excess is booked as
                an advance.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={record.isPending}
                disabled={amount <= 0}
              >
                Record payment
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
