import {
  useAutoMatchStatement,
  useBankStatement,
  useBankStatementSummary,
  useMatchLine,
  useUnmatchLine,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  useConfirm,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  Link2,
  Sparkles,
  Unlink,
} from "lucide-react";
import { useParams, Link as RouterLink } from "react-router-dom";
import { useCrumbTitle } from "../../../providers/breadcrumb-titles";

import { BankLineLink } from "../components/BankLineDrawer";

/**
 * One bank statement = list of lines + summary + auto/manual match actions.
 * The matcher is conservative — anything ambiguous lands here for human
 * decision.
 */
export function StatementDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const statement = useBankStatement(id);
  const summary = useBankStatementSummary(id);
  const autoMatch = useAutoMatchStatement();
  const matchLine = useMatchLine();
  const unmatchLine = useUnmatchLine();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();

  // Breadcrumb label — before the early returns, so the hook order
  // stays the same on the loading and loaded renders.
  useCrumbTitle(statement.data?.label ?? null);

  if (statement.isLoading) return <SkeletonCard />;
  if (!statement.data)
    return <p className="text-sm text-fg-muted">Statement not found.</p>;
  const s = statement.data;

  const onAutoMatch = async () => {
    try {
      const result = await autoMatch.mutateAsync(id);
      toast.success(
        result.matchedLines > 0
          ? `Matched ${result.matchedLines} line${result.matchedLines === 1 ? "" : "s"} (${formatMoney(result.matchedAmount)})`
          : "No new matches found — try manual match for the remaining lines.",
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Auto-match failed");
    }
  };

  const onManualMatch = async (lineId: string) => {
    const type = await askPrompt({
      title: "Match this line manually",
      message:
        "Pick a match type: LoanPayment, LoanDisbursement, MANUAL (for fees, owner draws, etc.). The refId is optional but recommended for the first two.",
      label: "Match type",
      placeholder: "LoanPayment",
      defaultValue: "MANUAL",
      confirmLabel: "Next",
    });
    if (type === null) return;
    const refId = await askPrompt({
      title: "Reference id (optional)",
      message:
        "For LoanPayment/LoanDisbursement, paste the loan or payment id. Leave blank for MANUAL.",
      label: "refId",
      placeholder: "uuid",
      confirmLabel: "Next",
    });
    if (refId === null) return;
    const note = await askPrompt({
      title: "Note (optional)",
      message: "Free-form context for the audit trail.",
      label: "Note",
      placeholder: "e.g. monthly bank fee",
      confirmLabel: "Match",
    });
    if (note === null) return;
    try {
      await matchLine.mutateAsync({
        lineId,
        statementId: id,
        type,
        refId: refId || undefined,
        note: note || undefined,
      });
      toast.success("Line matched");
    } catch (err) {
      toast.error((err as Error).message ?? "Match failed");
    }
  };

  const onUnmatch = async (lineId: string) => {
    const ok = await confirm({
      title: "Unmatch this line?",
      message:
        "The line will go back to unreconciled. The original journal entry is unaffected.",
      confirmLabel: "Unmatch",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await unmatchLine.mutateAsync({ lineId, statementId: id });
      toast.success("Line unmatched");
    } catch (err) {
      toast.error((err as Error).message ?? "Unmatch failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{s.label}</CardTitle>
            <p className="text-xs text-fg-muted mt-0.5">
              {s.bankAccount} · {formatDate(s.periodStart)} →{" "}
              {formatDate(s.periodEnd)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <RouterLink to="/reconciliation">
                <ArrowLeft className="h-3 w-3" />
                All statements
              </RouterLink>
            </Button>
            <Button onClick={onAutoMatch} disabled={autoMatch.isPending}>
              <Sparkles className="h-3 w-3" />
              {autoMatch.isPending ? "Matching…" : "Auto-match"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <Stat
              label="Opening"
              value={formatMoney(Number(s.openingBalance))}
            />
            <Stat
              label="Closing"
              value={formatMoney(Number(s.closingBalance))}
            />
            <Stat
              label="Lines"
              value={
                summary.data
                  ? `${summary.data.matched}/${summary.data.totalLines}`
                  : "—"
              }
              sub="matched/total"
            />
            <Stat
              label="Matched ₱"
              value={
                summary.data ? formatMoney(summary.data.matchedAmount) : "—"
              }
              accent="emerald"
            />
            <Stat
              label="Unmatched ₱"
              value={
                summary.data ? formatMoney(summary.data.unmatchedAmount) : "—"
              }
              accent={
                summary.data && summary.data.unmatched > 0 ? "amber" : undefined
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lines ({s.lines.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Date</th>
                <th className="py-2 px-2">Description</th>
                <th className="py-2 px-2">Ref</th>
                <th className="py-2 px-2 text-right">Amount</th>
                <th className="py-2 px-2">Match</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {s.lines.map((l) => {
                const amount = Number(l.amount);
                const matched = l.matchedAt !== null;
                return (
                  <tr key={l.id} className="hover:bg-hover">
                    <td className="py-2 px-2 text-xs">
                      {formatDate(l.txnDate)}
                    </td>
                    <td className="py-2 px-2">{l.description}</td>
                    <td className="py-2 px-2 font-mono text-[10px] text-fg-muted">
                      {l.reference ?? "—"}
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-mono ${amount < 0 ? "text-danger" : "text-success"}`}
                    >
                      {formatMoney(amount)}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {matched ? (
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3 text-success" />
                          <Badge variant="success">{l.matchedType}</Badge>
                          {l.matchNote && (
                            <span
                              className="text-fg-muted ml-1 truncate max-w-[12rem]"
                              title={l.matchNote}
                            >
                              {l.matchNote}
                            </span>
                          )}
                        </span>
                      ) : (
                        <BankLineLink line={l} statementId={id}>
                          <CircleHelp className="h-3 w-3" />
                          Unmatched
                        </BankLineLink>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {matched ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onUnmatch(l.id)}
                        >
                          <Unlink className="h-3 w-3" />
                          Unmatch
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onManualMatch(l.id)}
                        >
                          <Link2 className="h-3 w-3" />
                          Match
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
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
  accent?: "emerald" | "amber";
}) {
  const color =
    accent === "emerald"
      ? "text-success"
      : accent === "amber"
        ? "text-warning"
        : "text-fg";
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-muted">
        {label}
      </div>
      <div className={`font-mono text-sm mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-fg-subtle">{sub}</div>}
    </div>
  );
}
