import { downloadPortalLedgerCsv, usePortalLedger } from "@loan/api-client";
import type {
  CustomerLedgerEntry,
  CustomerLedgerEntryKind,
  CustomerLedgerScope,
  CustomerLedgerSummary,
} from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SkeletonCard,
  cn,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Coins,
  Download,
  FileDown,
  HandCoins,
  PiggyBank,
  Receipt,
  ShieldOff,
  Wallet,
} from "lucide-react";
import { useState } from "react";

import { downloadPdf } from "../../../lib/download-pdf";

/**
 * Borrower-facing statement of account. Reads /portal/me/ledger so the
 * customer only sees their own ledger; everything else mirrors the
 * staff CustomerLedgerPanel for visual consistency.
 *
 * We've intentionally duplicated the layout instead of sharing a
 * component because the staff version is wired to a customer id (passed
 * in), while this one resolves from the auth context. Trying to
 * generalise that would add prop sprawl with no clear gain.
 */
export function PortalLedgerPage() {
  const [scope, setScope] = useState<CustomerLedgerScope>("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const toast = useToast();

  const ledger = usePortalLedger({
    scope,
    from: from || undefined,
    to: to || undefined,
  });

  const [downloading, setDownloading] = useState(false);
  const onExportCsv = async () => {
    setDownloading(true);
    try {
      await downloadPortalLedgerCsv({
        scope,
        from: from || undefined,
        to: to || undefined,
      });
    } catch (err) {
      toast.error((err as Error).message ?? "Could not export statement");
    } finally {
      setDownloading(false);
    }
  };

  const onExportPdf = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("scope", scope);
      await downloadPdf(
        `/portal/me/ledger.pdf?${params.toString()}`,
        "my-statement.pdf",
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Could not download PDF");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              My ledger
            </CardTitle>
            <p className="text-xs text-fg-muted mt-1">
              Statement of account — everything you've borrowed, paid, saved,
              and contributed.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={onExportPdf}
              disabled={downloading || !ledger.data}
            >
              <FileDown className="h-3.5 w-3.5" />
              Download PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onExportCsv}
              disabled={downloading || !ledger.data}
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ledger.data && <SummaryStats summary={ledger.data.summary} />}

          <div className="flex flex-wrap items-end gap-3 border-t border-default pt-3">
            <div className="flex items-center gap-1.5">
              <ScopeChip
                label="All"
                active={scope === "ALL"}
                onClick={() => setScope("ALL")}
              />
              <ScopeChip
                label="Loans"
                active={scope === "LOANS"}
                onClick={() => setScope("LOANS")}
              />
              <ScopeChip
                label="Cooperative"
                active={scope === "COOP"}
                onClick={() => setScope("COOP")}
              />
            </div>
            <div className="flex items-end gap-2 ml-auto">
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-fg-subtle">
                  From
                </Label>
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8 text-xs w-36"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-fg-subtle">
                  To
                </Label>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8 text-xs w-36"
                />
              </div>
              {(from || to) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          {ledger.isLoading ? (
            <SkeletonCard />
          ) : (ledger.data?.entries ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">No activity in this range.</p>
          ) : (
            <LedgerTable entries={ledger.data!.entries} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Stats + chip + table — same shape as the staff panel ────────────

function SummaryStats({ summary }: { summary: CustomerLedgerSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
      <Stat
        label="Outstanding"
        value={formatMoney(summary.outstandingPrincipal)}
        accent={summary.outstandingPrincipal > 0 ? "warning" : "success"}
        icon={Wallet}
        sub={`${formatMoney(summary.totalDisbursed)} disbursed`}
      />
      <Stat
        label="Total paid"
        value={formatMoney(summary.totalRepaid)}
        accent="success"
        icon={Receipt}
        sub={
          summary.totalPenaltyWaived > 0
            ? `${formatMoney(summary.totalPenaltyWaived)} waived`
            : undefined
        }
      />
      <Stat
        label="Savings"
        value={formatMoney(summary.savingsBalance)}
        accent={summary.savingsBalance > 0 ? "success" : "muted"}
        icon={PiggyBank}
        sub={`${formatMoney(summary.savingsDeposits)} in · ${formatMoney(summary.savingsWithdrawals)} out`}
      />
      <Stat
        label="Contributions"
        value={formatMoney(summary.contributionsTotal)}
        accent="info"
        icon={HandCoins}
        sub={`CBU ${formatMoney(summary.capitalBuildUp)}`}
      />
      {/*
        This is the borrower's OWN statement, which is what made the old
        "Net depositor ₱6,735.76" worst here: it told a member the coop
        was holding money for them that it does not hold and does not
        owe — the figure was the interest they had just finished paying.

        Two positions now, in the second person, and never summed. What
        you owe and what we hold are different claims; a member with
        ₱10,000 saved and ₱10,000 borrowed is not square with the coop.
      */}
      <Stat
        label="You owe"
        value={formatMoney(summary.amountOwed)}
        accent={summary.amountOwed > 0 ? "warning" : "success"}
        icon={Coins}
        sub={
          summary.amountOwed > 0
            ? "On your live loans, interest included"
            : "You're all paid up"
        }
      />
      <Stat
        label="We hold for you"
        value={formatMoney(summary.amountHeld)}
        accent="info"
        icon={PiggyBank}
        sub="Your savings + capital build-up"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  accent,
  sub,
}: {
  label: string;
  value: string;
  icon: typeof Wallet;
  accent: "primary" | "success" | "warning" | "danger" | "info" | "muted";
  sub?: string;
}) {
  const accentClass: Record<typeof accent, string> = {
    primary: "text-primary bg-primary-soft",
    success: "text-success bg-success-soft",
    warning: "text-warning bg-warning-soft",
    danger: "text-danger bg-danger-soft",
    info: "text-info bg-info-soft",
    muted: "text-fg-muted bg-surface-3",
  };
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-7 w-7 rounded-md border border-default flex items-center justify-center shrink-0",
            accentClass[accent],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle truncate">
            {label}
          </div>
          <div className="text-sm font-semibold tabular truncate">{value}</div>
        </div>
      </div>
      {sub && (
        <div className="text-[10px] text-fg-subtle tabular mt-1 truncate">
          {sub}
        </div>
      )}
    </div>
  );
}

function ScopeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary-soft text-primary"
          : "border-default bg-surface-2 text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

const KIND_LABELS: Record<CustomerLedgerEntryKind, string> = {
  LOAN_DISBURSEMENT: "Loan disbursed",
  LOAN_PAYMENT: "Loan payment",
  PENALTY_WAIVER: "Penalty waived",
  CONTRIBUTION: "Contribution",
  SAVINGS_DEPOSIT: "Savings deposit",
  SAVINGS_WITHDRAWAL: "Savings withdrawal",
};

const KIND_ICONS: Record<CustomerLedgerEntryKind, typeof Wallet> = {
  LOAN_DISBURSEMENT: Wallet,
  LOAN_PAYMENT: Receipt,
  PENALTY_WAIVER: ShieldOff,
  CONTRIBUTION: HandCoins,
  SAVINGS_DEPOSIT: PiggyBank,
  SAVINGS_WITHDRAWAL: PiggyBank,
};

function LedgerTable({ entries }: { entries: CustomerLedgerEntry[] }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2 font-medium">Date</th>
            <th className="py-2 px-2 font-medium">Kind</th>
            <th className="py-2 px-2 font-medium">Description</th>
            <th className="py-2 px-2 font-medium text-right">In</th>
            <th className="py-2 px-2 font-medium text-right">Out</th>
            {/* Two totals, never one. A single "Balance" mixing them
                showed ₱50,000 in the In column producing −₱50,000, and
                let interest accumulate as though it were savings. */}
            <th className="py-2 px-2 font-medium text-right">You owe</th>
            <th className="py-2 px-2 font-medium text-right">We hold</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {entries.map((e, i) => {
            const Icon = KIND_ICONS[e.kind];
            const isInflow = e.direction === "INFLOW";
            return (
              <tr
                key={`${e.date}-${i}`}
                className="hover:bg-surface-3/40 transition-colors"
              >
                <td className="py-2 px-2 tabular text-xs text-fg-muted whitespace-nowrap">
                  {formatDate(e.date)}
                </td>
                <td className="py-2 px-2">
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <Icon className="h-3.5 w-3.5 text-fg-subtle" />
                    {KIND_LABELS[e.kind]}
                  </span>
                </td>
                <td className="py-2 px-2">
                  <div className="text-xs text-fg">{e.description}</div>
                  {e.notes && (
                    <div className="text-[10px] text-fg-subtle truncate max-w-[280px]">
                      {e.notes}
                    </div>
                  )}
                  {e.loanNumber && (
                    <Badge variant="muted" className="mt-1">
                      {e.loanNumber}
                    </Badge>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular">
                  {isInflow ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <ArrowDownLeft className="h-3 w-3" />
                      {formatMoney(e.amount)}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular">
                  {!isInflow ? (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <ArrowUpRight className="h-3 w-3" />
                      {formatMoney(e.amount)}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                </td>
                <td
                  className={
                    "py-2 px-2 text-right tabular text-xs " +
                    (e.owedAfter > 0 ? "text-warning" : "text-fg-subtle")
                  }
                >
                  {formatMoney(e.owedAfter)}
                </td>
                <td className="py-2 px-2 text-right tabular text-xs text-info">
                  {formatMoney(e.heldAfter)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
