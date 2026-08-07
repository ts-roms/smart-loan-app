import { useMyAgentBook, useMyPayable } from "@loan/api-client";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { Briefcase, Receipt, Wallet } from "lucide-react";

import { AgentBookTable } from "../components/AgentBookTable";
import { AgentStats } from "../components/AgentStats";

/**
 * What an agent sees of themselves: their loans, and what they made.
 *
 * There is no id in the URL and no agent picker. The server resolves the
 * agent from the token, so this page renders one book and only one — an
 * agent cannot reach a colleague's earnings by editing an address bar.
 *
 * Borrower names appear but are not linked: the AGENT role does not
 * carry `customers.read`, so those links would 403. Their own book is
 * the only borrower data they are given, and that is by design.
 */
export function MyBookPage() {
  const book = useMyAgentBook();
  const payable = useMyPayable();

  if (book.isLoading) return <SkeletonCard />;

  if (book.isError) {
    /*
     * Almost always one thing: a signed-in user with the permission but
     * no Agent row behind them. The API says so in the message, so pass
     * it through rather than replacing it with "something went wrong" —
     * "ask an administrator to register you as an agent" is actionable
     * and the generic version is not.
     */
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-fg-muted">
            {(book.error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const data = book.data!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">My book</h1>
        <p className="text-xs text-fg-muted">
          {data.agent.number}
          {data.agent.territory ? ` · ${data.agent.territory}` : ""}
        </p>
      </div>

      <AgentStats totals={data.totals} voice="own" />

      {/*
        The number an agent actually cares about, and the one the stats
        above do not give them. "Earned" is their career total, paid and
        unpaid together; this is what the coop still owes them today.
      */}
      {payable.data && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="h-4 w-4" />
              Waiting to be paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="text-2xl font-semibold tabular text-warning">
                  {formatMoney(payable.data.payableTotal)}
                </div>
                <p className="text-[11px] text-fg-muted">
                  Across {payable.data.loans.length}{" "}
                  {payable.data.loans.length === 1 ? "loan" : "loans"} ·{" "}
                  {formatMoney(payable.data.paidTotal)} paid to you so far
                </p>
              </div>
            </div>
            {payable.data.loans.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-default pt-3">
                {payable.data.loans.map((l) => (
                  <div
                    key={l.loanId}
                    className="flex items-baseline justify-between text-xs"
                  >
                    <span className="text-fg-muted">
                      {l.loanNumber} · {l.customerName} ·{" "}
                      {formatDate(l.postedAt)}
                    </span>
                    <span className="tabular">
                      {formatMoney(l.commissionAmount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {payable.data?.payouts && payable.data.payouts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Receipt className="h-4 w-4" />
              What you have been paid
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {payable.data.payouts.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-default py-1.5 text-xs last:border-0"
              >
                <span className="text-fg-muted">
                  {p.number} · {formatDate(p.paidOn)}
                  {p.method ? ` · ${p.method}` : ""}
                  <span className="ml-1 text-fg-subtle">
                    ({p.items.map((i) => i.loanNumber).join(", ") || "—"})
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {p.voidedAt && <Badge variant="muted">Voided</Badge>}
                  <span
                    className={
                      p.voidedAt
                        ? "tabular text-fg-subtle line-through"
                        : "tabular text-success"
                    }
                  >
                    {formatMoney(p.amount)}
                  </span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Briefcase className="h-4 w-4" />
            Loans you brought in
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AgentBookTable loans={data.loans} />
          <p className="mt-3 text-[11px] text-fg-subtle">
            Commission is earned when the loan is disbursed, not when it is
            approved. Rows still in review show what they would pay.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
