import { useMemberLedger } from "@loan/api-client";
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
import { ArrowUpRight, HandCoins, PiggyBank, UserCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Click-to-inspect wrapper for a cooperative member. Wraps a child trigger
 * (typically the member's name); clicking opens a right-side drawer with
 * their cooperative position: lifetime CBU / Mortuary / Emergency, savings
 * net balance, and recent transactions.
 *
 * Usage:
 *   <MemberLedgerLink customerId={c.customerId}>
 *     {nameOf(c.customerId)}
 *   </MemberLedgerLink>
 */
export function MemberLedgerLink({
  customerId,
  children,
}: {
  customerId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!customerId) return <>{children}</>;
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left hover:text-info focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-label="Open member ledger"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <MemberLedgerInspector customerId={customerId} />
      </DrawerContent>
    </Drawer>
  );
}

function MemberLedgerInspector({ customerId }: { customerId: string }) {
  const ledger = useMemberLedger(customerId);

  if (ledger.isLoading) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Member ledger</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </DrawerBody>
      </>
    );
  }
  if (!ledger.data) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Member ledger</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <p className="text-sm text-fg-muted">Member not found.</p>
        </DrawerBody>
      </>
    );
  }

  const { customer, totals, recentContributions, recentSavings } = ledger.data;
  const fullName = [customer.firstName, customer.middleName, customer.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <UserCircle className="h-5 w-5 mt-0.5 text-info" />
          <div className="flex-1 min-w-0">
            <DrawerTitle>{fullName}</DrawerTitle>
            <DrawerDescription>
              {customer.email ?? "—"} · {customer.phone}
              <br />
              <span className="font-mono">
                {customer.governmentIdType} {customer.governmentIdNumber}
              </span>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* Totals */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5 flex items-center gap-1">
            <HandCoins className="h-3 w-3" />
            Lifetime contributions
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="CBU" value={formatMoney(totals.capitalBuildUp)} />
            <Stat label="Mortuary" value={formatMoney(totals.mortuaryFund)} />
            <Stat label="Emergency" value={formatMoney(totals.emergencyFund)} />
          </div>
          <div className="text-[10px] text-fg-subtle mt-1">
            Across {totals.contributionsCount} contribution
            {totals.contributionsCount === 1 ? "" : "s"}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5 flex items-center gap-1">
            <PiggyBank className="h-3 w-3" />
            Savings balance
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Net"
              value={formatMoney(totals.savingsNet)}
              accent={totals.savingsNet >= 0 ? "emerald" : "rose"}
            />
            <Stat
              label="Deposits"
              value={formatMoney(totals.savingsDeposits)}
              sub={`${totals.depositCount} txn`}
            />
            <Stat
              label="Withdrawals"
              value={formatMoney(totals.savingsWithdrawals)}
              sub={`${totals.withdrawalCount} txn`}
            />
          </div>
        </div>

        {/* Recent activity */}
        {recentContributions.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5">
              Recent contributions
            </div>
            <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
              {recentContributions.slice(0, 8).map((c) => {
                const total =
                  Number(c.capitalBuildUp) +
                  Number(c.mortuaryFund) +
                  Number(c.emergencyFund);
                return (
                  <div
                    key={c.id}
                    className="px-2.5 py-1.5 text-xs flex items-center justify-between"
                  >
                    <div className="text-fg-muted">
                      {formatDate(c.contributedAt)}
                    </div>
                    <div className="font-mono font-semibold">
                      {formatMoney(total)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {recentSavings.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5">
              Recent savings
            </div>
            <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
              {recentSavings.slice(0, 8).map((s) => (
                <div
                  key={s.id}
                  className="px-2.5 py-1.5 text-xs flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-fg-muted">
                      {formatDate(s.txnDate)}
                    </span>
                    <Badge variant={s.kind === "DEPOSIT" ? "success" : "muted"}>
                      {s.kind}
                    </Badge>
                  </div>
                  <div
                    className={`font-mono ${s.kind === "DEPOSIT" ? "text-success" : "text-danger"}`}
                  >
                    {formatMoney(Number(s.amount))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <Link
            to={`/customers/${customer.number}`}
            className="inline-flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open customer profile
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "rose";
}) {
  const color =
    accent === "emerald"
      ? "text-success"
      : accent === "rose"
        ? "text-danger"
        : "text-fg";
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className={`font-mono text-sm mt-0.5 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-fg-subtle mt-0.5">{sub}</div>}
    </div>
  );
}
