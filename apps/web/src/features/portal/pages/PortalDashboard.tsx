import {
  usePortalKyc,
  usePortalLoans,
  usePortalMe,
  usePortalMemberLedger,
} from "@loan/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  CreditCard,
  FileCheck2,
  Gauge,
  HandCoins,
  PiggyBank,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";

// Pulled from features/loans so the borrower-side product chips render
// with the same short labels as the officer console.
import { LOAN_TYPE_LABELS } from "../../loans";

export function PortalDashboard() {
  const me = usePortalMe();
  const loans = usePortalLoans();
  const kyc = usePortalKyc();
  // Member ledger is a separate endpoint so a slow / empty cooperative
  // table doesn't block the rest of the dashboard. Failure is silent —
  // the widget just doesn't render.
  const ledger = usePortalMemberLedger();

  if (me.isLoading || loans.isLoading) return <SkeletonCard />;

  const active = (loans.data ?? []).filter((l) =>
    ["DISBURSED", "ACTIVE"].includes(l.status),
  );
  /*
   * What's actually still owed, from the server-computed balance.
   *
   * This used to sum `l.principal` — the amount originally borrowed —
   * and label it Outstanding, so a borrower who had repaid 90% of a
   * ₱500,000 loan was told they still owed ₱500,000. It also
   * contradicted the correct figure on the loan detail page one click
   * away. The list endpoint now carries the real balance; see
   * PortalService.listLoans.
   *
   * Falls back to the principal only when the balance is missing, which
   * for an active loan means the schedule hasn't been generated — rare,
   * and over-stating is the safer direction of the two.
   */
  const outstanding = active.reduce(
    (sum, l) => sum + (l.balance?.outstanding ?? Number(l.principal)),
    0,
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          Hello, {me.data?.customer.firstName} 👋
        </h1>
        <p className="text-sm text-fg-muted">
          {kyc.data?.status.complete
            ? "Your account is verified. You can apply for new loans."
            : "Please complete your KYC documents to unlock new loans."}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat
          label="Active loans"
          icon={CreditCard}
          value={String(active.length)}
        />
        <Stat
          label="Outstanding"
          icon={Gauge}
          value={formatMoney(outstanding)}
        />
        <Stat
          label="KYC status"
          icon={FileCheck2}
          value={kyc.data?.status.status ?? "NONE"}
        />
      </div>

      {/*
        My membership card — lifetime cooperative totals. Hidden when
        the ledger query hasn't returned (graceful for non-member
        accounts and for first-time loads).
      */}
      {ledger.data && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-success" />
              My membership
            </CardTitle>
            <div className="flex items-center gap-2 text-xs">
              <Link
                to="/portal/contributions"
                className="text-info hover:underline"
              >
                Contributions →
              </Link>
              <Link to="/portal/savings" className="text-info hover:underline">
                Savings →
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <LedgerCell
                label="Capital Build-Up"
                value={formatMoney(ledger.data.totals.capitalBuildUp)}
                icon={HandCoins}
              />
              <LedgerCell
                label="Mortuary Fund"
                value={formatMoney(ledger.data.totals.mortuaryFund)}
                icon={HandCoins}
              />
              <LedgerCell
                label="Emergency Fund"
                value={formatMoney(ledger.data.totals.emergencyFund)}
                icon={HandCoins}
              />
              <LedgerCell
                label="Savings balance"
                value={formatMoney(ledger.data.totals.savingsNet)}
                icon={PiggyBank}
                tone={ledger.data.totals.savingsNet >= 0 ? "good" : "bad"}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>My loans</CardTitle>
        </CardHeader>
        <CardContent>
          {(loans.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">
              You don't have any loans yet.{" "}
              <Link to="/portal/apply" className="text-info hover:underline">
                Apply for one →
              </Link>
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Number</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Principal</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(loans.data ?? []).map((l) => (
                  <tr key={l.id} className="hover:bg-hover">
                    <td className="py-2 px-2 font-mono">
                      <Link
                        to={`/portal/loans/${l.number}`}
                        className="text-info hover:underline"
                      >
                        {l.number}
                      </Link>
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant="muted">
                        {LOAN_TYPE_LABELS[l.productCode] ?? l.productCode}
                      </Badge>
                    </td>
                    <td className="py-2 px-2">
                      {formatMoney(Number(l.principal))}
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant={badgeVariant(l.status)}>{l.status}</Badge>
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDate(l.submittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function badgeVariant(
  status: string,
): "success" | "danger" | "muted" | "warning" {
  if (["APPROVED", "DISBURSED", "ACTIVE"].includes(status)) return "success";
  if (["REJECTED", "DEFAULTED", "CANCELLED"].includes(status)) return "danger";
  if (status === "CLOSED") return "muted";
  return "warning";
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof CreditCard;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div>
          <div className="text-xs text-fg-muted uppercase tracking-wider">
            {label}
          </div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <Icon className="h-8 w-8 text-info opacity-60" />
      </CardContent>
    </Card>
  );
}

function LedgerCell({
  label,
  value,
  icon: Icon,
  tone = "info",
}: {
  label: string;
  value: string;
  icon: typeof HandCoins;
  tone?: "info" | "good" | "bad";
}) {
  const toneClass = {
    info: "text-fg",
    good: "text-success",
    bad: "text-danger",
  }[tone];
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3 flex items-start gap-2">
      <Icon className="h-4 w-4 text-success mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle truncate">
          {label}
        </div>
        <div
          className={`text-base font-semibold font-mono ${toneClass} truncate`}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
