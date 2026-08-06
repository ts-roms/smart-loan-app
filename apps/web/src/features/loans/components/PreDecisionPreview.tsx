import type { AnomalyFlag, LoanDryRunResult } from "@loan/shared-types";
import { Badge } from "@loan/ui";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Sparkles,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useDryRunLoan } from "../hooks";

export interface PreDecisionPreviewProps {
  customerId: string;
  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a percentage (24 means 24% APR). */
  ratePercent: number;
}

/**
 * "What would the rules engine say?" panel that lives at the bottom of
 * the new-loan dialog, just above the Submit button. Calls POST
 * /loans/dry-run on a 500ms debounce as the officer edits the form,
 * showing:
 *
 *   • Top: a stoplight (Approve / Review / Reject) with the matched
 *     rule and its `reason` string.
 *   • Pre-flight gates: AML match flag, KYC complete flag. These don't
 *     come from a rule — they're hard-coded blockers in the apply +
 *     decide handlers. Surface them so the officer isn't surprised.
 *   • Decisioning context echo: tier, score, income, existing-loan
 *     count. Helps the officer understand *why* a given verdict came
 *     out the way it did.
 *
 * The dry-run is idempotent + side-effect-free server-side, so calling
 * it on every debounced edit is cheap.
 */
export function PreDecisionPreview({
  customerId,
  productCode,
  principal,
  termMonths,
  ratePercent,
}: PreDecisionPreviewProps) {
  const dryRun = useDryRunLoan();
  const [result, setResult] = useState<LoanDryRunResult | null>(null);
  const [debouncing, setDebouncing] = useState(false);

  // Debounce the run so we don't fire on every keystroke. 500ms feels
  // right: short enough to keep up with the user, long enough that
  // typing "12000" doesn't dispatch four wasted requests.
  useEffect(() => {
    if (
      !customerId ||
      !productCode ||
      principal <= 0 ||
      termMonths <= 0 ||
      ratePercent < 0
    ) {
      setResult(null);
      setDebouncing(false);
      return;
    }
    setDebouncing(true);
    const timer = window.setTimeout(() => {
      dryRun.mutate(
        {
          customerId,
          productCode,
          principal,
          termMonths,
          annualInterestRate: ratePercent / 100,
        },
        {
          onSuccess: (data) => {
            setResult(data);
            setDebouncing(false);
          },
          onError: () => {
            setResult(null);
            setDebouncing(false);
          },
        },
      );
    }, 500);
    return () => {
      window.clearTimeout(timer);
      setDebouncing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, productCode, principal, termMonths, ratePercent]);

  if (!customerId) return null;

  // Loading state: keep prior result visible to avoid layout jumps.
  const isBusy = dryRun.isPending || debouncing;

  // Resolve display tone from verdict + gates. Gates override the
  // verdict only insofar as we WARN about them — the verdict itself
  // is still whatever the rules engine returned.
  if (!result) {
    return (
      <div className="rounded-md border border-default bg-surface-2 p-3 text-xs text-fg-muted flex items-center gap-2">
        <Loader2 className={`h-3 w-3 ${isBusy ? "animate-spin" : ""}`} />
        {isBusy
          ? "Running pre-decisioning preview…"
          : "Pre-decisioning preview will appear here."}
      </div>
    );
  }

  const verdictMeta = VERDICT_META[result.verdict];
  const hasBlockingGate = result.gates.amlMatch || !result.gates.kycComplete;

  return (
    <div
      className={`rounded-md border ${verdictMeta.borderClass} ${verdictMeta.bgClass} p-3 space-y-2`}
    >
      {/* Verdict header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <verdictMeta.Icon className={`h-4 w-4 ${verdictMeta.iconClass}`} />
          <span className="text-sm font-semibold">{verdictMeta.label}</span>
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
            · Pre-decisioning preview
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {isBusy && (
            <Loader2 className="h-3 w-3 animate-spin text-fg-subtle" />
          )}
          <Badge variant={verdictMeta.badgeVariant}>
            {result.verdict === "APPROVE"
              ? "Auto-approve likely"
              : result.verdict === "REJECT"
                ? "Auto-reject likely"
                : "Manual review"}
          </Badge>
        </div>
      </div>

      {/* Reason */}
      <div className="text-xs text-fg">
        {result.reason}
        {result.matchedRule && (
          <span className="text-fg-subtle">
            {" "}
            · rule:{" "}
            <span className="font-mono text-fg-muted">
              {result.matchedRule.name}
            </span>
          </span>
        )}
      </div>

      {/* Pre-flight gates (always render so an officer who sees a green
          verdict still understands what gates are open). */}
      {(hasBlockingGate || result.gates.amlMatch === false) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 border-t border-default pt-2">
          <GateRow
            ok={!result.gates.amlMatch}
            okLabel="AML clear"
            failLabel="AML MATCH active — apply will be blocked (409)"
          />
          <GateRow
            ok={result.gates.kycComplete}
            okLabel="KYC pack verified"
            failLabel={`KYC incomplete — ${result.gates.missingKycDocs.length} missing, ${result.gates.rejectedKycDocs.length} rejected`}
          />
        </div>
      )}

      {/* Anomaly flags — z-score outliers + velocity + ratio checks */}
      {result.anomalies.length > 0 && (
        <AnomalyList anomalies={result.anomalies} />
      )}

      {/* Context echo — small/dim, mostly diagnostic */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-subtle border-t border-default pt-2 font-mono">
        <span>
          score: {result.context.creditScore ?? "—"}
          {result.context.tier && ` (${result.context.tier})`}
        </span>
        <span>·</span>
        <span>active loans: {result.context.existingActiveLoans}</span>
        <span>·</span>
        <span>income: ₱{result.context.monthlyIncome.toLocaleString()}</span>
      </div>
    </div>
  );
}

/**
 * Render the statistical + heuristic flags returned by /loans/dry-run.
 * Filters out the INSUFFICIENT_BASELINE row when it's the only entry
 * (it's diagnostic noise for empty products); keeps it visible
 * alongside real flags so the officer knows the product is still
 * collecting historical data.
 */
function AnomalyList({ anomalies }: { anomalies: AnomalyFlag[] }) {
  const realFlags = anomalies.filter((a) => a.code !== "INSUFFICIENT_BASELINE");
  // If the only flag is INSUFFICIENT_BASELINE, render a single muted hint.
  if (realFlags.length === 0) {
    const baseline = anomalies[0];
    if (!baseline) return null;
    return (
      <div className="border-t border-default pt-2 text-[10px] text-fg-subtle italic">
        {baseline.message}
      </div>
    );
  }
  return (
    <div className="border-t border-default pt-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
        <Sparkles className="h-3 w-3 text-warning" />
        Anomaly flags · {realFlags.length}
      </div>
      <ul className="space-y-1">
        {realFlags.map((flag) => (
          <AnomalyRow key={`${flag.code}-${flag.observed ?? 0}`} flag={flag} />
        ))}
      </ul>
    </div>
  );
}

function AnomalyRow({ flag }: { flag: AnomalyFlag }) {
  const SEVERITY: Record<
    AnomalyFlag["severity"],
    { color: string; label: string }
  > = {
    high: {
      color: "text-danger bg-danger/10 border-danger/30",
      label: "High",
    },
    medium: {
      color: "text-warning bg-warning/10 border-warning/30",
      label: "Medium",
    },
    low: {
      color: "text-fg bg-surface-2 border-default",
      label: "Low",
    },
  };
  const s = SEVERITY[flag.severity];
  return (
    <li
      className={`rounded border ${s.color} px-2 py-1.5 text-[11px] flex items-start gap-2`}
    >
      <span className="text-[9px] font-mono uppercase tracking-wider mt-0.5 shrink-0">
        {s.label}
      </span>
      <span className="flex-1">{flag.message}</span>
    </li>
  );
}

const VERDICT_META = {
  APPROVE: {
    label: "Likely approve",
    Icon: ThumbsUp,
    iconClass: "text-success",
    borderClass: "border-success/30",
    bgClass: "bg-success/[0.06]",
    badgeVariant: "success" as const,
  },
  REVIEW: {
    label: "Manual review needed",
    Icon: AlertTriangle,
    iconClass: "text-warning",
    borderClass: "border-warning/30",
    bgClass: "bg-warning/[0.06]",
    badgeVariant: "warning" as const,
  },
  REJECT: {
    label: "Likely reject",
    Icon: ShieldAlert,
    iconClass: "text-danger",
    borderClass: "border-danger/30",
    bgClass: "bg-danger/[0.08]",
    badgeVariant: "danger" as const,
  },
} as const;

function GateRow({
  ok,
  okLabel,
  failLabel,
}: {
  ok: boolean;
  okLabel: string;
  failLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {ok ? (
        <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
      ) : (
        <XCircle className="h-3 w-3 text-danger shrink-0" />
      )}
      <span className={ok ? "text-success" : "text-danger"}>
        {ok ? okLabel : failLabel}
      </span>
    </div>
  );
}
