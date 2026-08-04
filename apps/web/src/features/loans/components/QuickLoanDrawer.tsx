import { useLoan } from "@loan/api-client";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  SkeletonLine,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { ArrowUpRight, CalendarClock, Coins, CreditCard } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "./StatusBadge";
import { TYPE_LABELS } from "../constants";

/**
 * Quick-peek wrapper for a loan id. Wraps a child trigger (typically the
 * loan number); clicking opens a right-side drawer with the key facts —
 * status, principal, term, rate, last payments, next due — without
 * navigating away from the list. The footer links into the full detail
 * page for users who need the deeper inspection.
 *
 * Usage:
 *   <QuickLoanLink id={loan.id}>{loan.number}</QuickLoanLink>
 */
export function QuickLoanLink({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left text-info hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 rounded"
          aria-label="Quick-view loan"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <QuickLoanInspector id={id} />
      </DrawerContent>
    </Drawer>
  );
}

function QuickLoanInspector({ id }: { id: string }) {
  const loan = useLoan(id);

  if (loan.isLoading) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Loan</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </DrawerBody>
      </>
    );
  }
  if (!loan.data) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Loan</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <p className="text-sm text-fg-muted">Loan not found.</p>
        </DrawerBody>
      </>
    );
  }

  const l = loan.data;
  const principal = Number(l.principal);
  const rate = Number(l.annualInterestRate);

  // Next installment = earliest schedule row with paidInFullAt null.
  const nextDue = (l.schedule ?? [])
    .filter((s) => !s.paidInFullAt)
    .sort(
      (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
    )[0];
  const lastPayments = (l.payments ?? [])
    .slice()
    .sort((a, b) => new Date(b.paidOn).getTime() - new Date(a.paidOn).getTime())
    .slice(0, 5);

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <CreditCard className="h-5 w-5 mt-0.5 text-info" />
          <div className="flex-1 min-w-0">
            <DrawerTitle className="font-mono">{l.number}</DrawerTitle>
            <DrawerDescription>
              <Badge variant="muted">
                {TYPE_LABELS[l.productCode] ?? l.productCode}
              </Badge>
              <span className="ml-2">
                <LoanStatusBadge status={l.status} />
              </span>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* Key facts */}
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Principal" value={formatMoney(principal)} />
          <Stat label="Term" value={`${l.termMonths} mo`} />
          <Stat label="Rate" value={`${(rate * 100).toFixed(2)}%`} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Stat label="Submitted" value={formatDate(l.submittedAt)} />
          <Stat
            label="Decided"
            value={l.decidedAt ? formatDate(l.decidedAt) : "—"}
          />
          <Stat
            label="Disbursed"
            value={l.disbursedAt ? formatDate(l.disbursedAt) : "—"}
          />
          <Stat
            label="Closed"
            value={l.closedAt ? formatDate(l.closedAt) : "—"}
          />
        </div>

        {/* Next due */}
        {nextDue && (
          <div className="rounded-md border border-sky-400/30 bg-sky-500/10 p-3 text-xs">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-info mb-1">
              <CalendarClock className="h-3 w-3" />
              Next due
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-fg">{formatDate(nextDue.dueDate)}</div>
                <div className="text-[10px] text-fg-muted">
                  Installment #{nextDue.installmentNo}
                </div>
              </div>
              <div className="font-mono font-semibold text-fg">
                {formatMoney(Number(nextDue.totalDue))}
              </div>
            </div>
          </div>
        )}

        {/* Recent payments */}
        {lastPayments.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5 flex items-center gap-1">
              <Coins className="h-3 w-3" />
              Recent payments
            </div>
            <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
              {lastPayments.map((p) => (
                <div
                  key={p.id}
                  className="px-2.5 py-1.5 text-xs flex items-center justify-between"
                >
                  <div className="text-fg-muted">
                    {formatDate(p.paidOn)}
                    {p.reference && (
                      <span className="ml-1 font-mono text-[10px] text-fg-subtle">
                        {p.reference}
                      </span>
                    )}
                  </div>
                  <div className="font-mono font-semibold text-success">
                    {formatMoney(Number(p.amount))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Decision reason */}
        {l.decisionReason && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
              Decision reason
            </div>
            <p className="text-xs text-fg">{l.decisionReason}</p>
          </div>
        )}
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <Link
            to={`/loans/${l.number}`}
            className="inline-flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open full detail
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="font-mono text-sm mt-0.5">{value}</div>
    </div>
  );
}
