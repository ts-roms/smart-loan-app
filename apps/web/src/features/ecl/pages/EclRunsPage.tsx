import { useEclRuns, useRunEcl, type EclRunResult } from "@loan/api-client";
import { JournalEntryLink } from "../../accounting";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  Activity,
  AlertTriangle,
  Layers,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * IFRS 9 / PFRS 9 ECL provisioning.
 *
 * Each run classifies every active loan into Stage 1/2/3 by DPD,
 * computes ECL = PD × LGD × EAD, persists the new stage + provision on
 * each loan, writes an EclRun summary row, and books the period-on-period
 * delta to the GL (DR Impairment Loss / CR Allowance for Doubtful).
 *
 * Permissions: `accounting.read` to view, `accounting.accrue` to run.
 */
export function EclRunsPage() {
  const runs = useEclRuns();
  const runEcl = useRunEcl();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canRun = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";
  const [lastResult, setLastResult] = useState<EclRunResult | null>(null);

  const onRun = async () => {
    const ok = await confirm({
      title: "Run ECL provisioning?",
      message:
        "Computes the expected credit loss for every active loan as of today and books the period-on-period movement to the GL. This is idempotent — safe to re-run.",
      confirmLabel: "Run ECL",
    });
    if (!ok) return;
    try {
      const result = await runEcl.mutateAsync({});
      setLastResult(result);
      toast.success(
        `ECL run posted. Total provision ${formatMoney(result.totalEcl)} (Δ ${formatMoney(result.delta)})`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "ECL run failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-info" />
            ECL provisioning
          </CardTitle>
          {canRun && (
            <Button onClick={onRun} disabled={runEcl.isPending}>
              <RefreshCw
                className={
                  runEcl.isPending ? "h-3 w-3 animate-spin" : "h-3 w-3"
                }
              />
              {runEcl.isPending ? "Running…" : "Run ECL now"}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-muted">
            IFRS 9 / PFRS 9 staged provisioning. Stage 1 = performing (12-month
            PD), Stage 2 = significant increase (lifetime PD), Stage 3 =
            credit-impaired (lifetime PD, individually assessed). DPD-driven;
            per-product PD/LGD configured on Loan products.
          </p>
        </CardContent>
      </Card>

      {/* ──── Latest-run summary ──── */}
      {lastResult && <LastRunSummary result={lastResult} />}

      {/* ──── History table ──── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {runs.isLoading ? (
            <SkeletonCard />
          ) : (runs.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">
              No ECL runs yet. Click <strong>Run ECL now</strong> to compute the
              first period.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Period</th>
                  <th className="py-2 px-2">As of</th>
                  <th className="py-2 px-2 text-right">EAD</th>
                  <th className="py-2 px-2 text-right">Stage 1</th>
                  <th className="py-2 px-2 text-right">Stage 2</th>
                  <th className="py-2 px-2 text-right">Stage 3</th>
                  <th className="py-2 px-2 text-right">Total ECL</th>
                  <th className="py-2 px-2">Journal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(runs.data ?? []).map((r) => (
                  <tr key={r.id} className="hover:bg-hover">
                    <td className="py-2 px-2 text-xs">
                      {formatDate(r.periodStart)} → {formatDate(r.periodEnd)}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDateTime(r.asOf)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {formatMoney(Number(r.totalEad))}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="font-mono text-xs">
                        {formatMoney(Number(r.stage1Ecl))}
                      </div>
                      <div className="text-[10px] text-fg-subtle">
                        {r.stage1Count} loans
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="font-mono text-xs">
                        {formatMoney(Number(r.stage2Ecl))}
                      </div>
                      <div className="text-[10px] text-fg-subtle">
                        {r.stage2Count} loans
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="font-mono text-xs">
                        {formatMoney(Number(r.stage3Ecl))}
                      </div>
                      <div className="text-[10px] text-fg-subtle">
                        {r.stage3Count} loans
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono font-semibold">
                      {formatMoney(Number(r.totalEcl))}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {r.journalEntryId ? (
                        <JournalEntryLink id={r.journalEntryId}>
                          <Badge variant="success">Posted</Badge>
                        </JournalEntryLink>
                      ) : (
                        <Badge variant="muted">—</Badge>
                      )}
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

function LastRunSummary({ result }: { result: EclRunResult }) {
  const isBuild = result.delta > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-4 w-4" />
          Latest run
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Stat label="Total EAD" value={formatMoney(result.totalEad)} />
          <Stat
            label="Total ECL"
            value={formatMoney(result.totalEcl)}
            accent="sky"
          />
          <Stat
            label={`Δ from prior period (${isBuild ? "build" : "release"})`}
            value={formatMoney(Math.abs(result.delta))}
            accent={isBuild ? "rose" : "emerald"}
          />
          <Stat
            label="Journal entry"
            value={result.journalEntryId ? "Posted" : "None (Δ ≈ 0)"}
          />
        </div>

        <div className="grid grid-cols-3 gap-3 text-xs">
          {(["STAGE_1", "STAGE_2", "STAGE_3"] as const).map((s) => {
            const bucket = result.byStage[s];
            return (
              <div
                key={s}
                className="rounded-md border border-default bg-surface-2 p-3"
              >
                <div className="text-[10px] uppercase tracking-wider text-fg-muted">
                  {s.replace("_", " ")}
                </div>
                <div className="font-mono text-sm mt-1">
                  {formatMoney(bucket.ecl)}
                </div>
                <div className="text-[10px] text-fg-subtle">
                  {bucket.count} loans
                </div>
              </div>
            );
          })}
        </div>

        {result.perLoan.some((l) => l.stage === "STAGE_3") && (
          <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100 flex items-center gap-2">
            <AlertTriangle className="h-3 w-3" />
            {result.perLoan.filter((l) => l.stage === "STAGE_3").length} loan(s)
            now Stage 3 (credit-impaired) — review for write-off candidacy.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "sky" | "rose" | "emerald";
}) {
  const color =
    accent === "sky"
      ? "text-info"
      : accent === "rose"
        ? "text-danger"
        : accent === "emerald"
          ? "text-success"
          : "text-fg";
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-muted">
        {label}
      </div>
      <div className={`font-mono text-sm mt-1 ${color}`}>{value}</div>
    </div>
  );
}
