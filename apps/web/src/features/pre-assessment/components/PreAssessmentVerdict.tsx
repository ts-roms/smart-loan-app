import type { AnomalyFlag, PreAssessment } from "@loan/shared-types";
import { Badge } from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  Sparkles,
  ThumbsUp,
  XCircle,
} from "lucide-react";

/**
 * Renders a saved pre-assessment. Shared between the officer page and the
 * borrower portal — the only difference is `tone`, which drops the
 * internals (matched rule name, context echo) a borrower shouldn't see.
 *
 * Deliberately presentational: no fetching, no mutation. The two callers
 * own how an assessment gets created; this only shows one.
 *
 * Visually a sibling of loans/components/PreDecisionPreview, but not the
 * same component — that one renders a live, unsaved dry-run and owns its
 * own debounce. Merging them would couple a stored record to a form's
 * in-flight state.
 */
export function PreAssessmentVerdict({
  assessment,
  tone = "staff",
}: {
  assessment: PreAssessment;
  /** "borrower" hides internal underwriting policy. */
  tone?: "staff" | "borrower";
}) {
  const meta = VERDICT_META[assessment.verdict];
  const staff = tone === "staff";

  return (
    <div
      className={`rounded-md border ${meta.borderClass} ${meta.bgClass} p-3 space-y-2`}
    >
      {/* Verdict header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <meta.Icon className={`h-4 w-4 ${meta.iconClass}`} />
          <span className="text-sm font-semibold">
            {staff ? meta.label : meta.borrowerLabel}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle font-mono">
            {assessment.number}
          </span>
        </div>
        <Badge variant={meta.badgeVariant}>
          {staff ? meta.badge : meta.borrowerBadge}
        </Badge>
      </div>

      {/* Reason. The rule's name is internal underwriting policy, so it
          renders for staff only — the borrower gets the reason text the
          rule was written to show them. */}
      <div className="text-xs text-fg">
        {assessment.reason}
        {staff && assessment.matchedRuleName && (
          <span className="text-fg-subtle">
            {" "}
            · rule:{" "}
            <span className="font-mono text-fg-muted">
              {assessment.matchedRuleName}
            </span>
          </span>
        )}
      </div>

      {/* An INDICATIVE result came from typed-in figures with no credit
          file, no AML screen and no KYC behind it. Saying so is the whole
          difference between a quote and a promise. */}
      {assessment.basis === "INDICATIVE" && (
        <div className="flex items-start gap-1.5 rounded border border-default bg-surface-2 px-2 py-1.5 text-[11px] text-fg-muted">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Indicative only — run against the figures entered, with no credit
            score, AML screening or verified documents on file. A full
            assessment needs a customer record.
          </span>
        </div>
      )}

      {/* Pre-flight gates. Null for a prospect: nothing to check against. */}
      {assessment.gates && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 border-t border-default pt-2">
          <GateRow
            ok={!assessment.gates.amlMatch}
            okLabel={staff ? "AML clear" : "Background check clear"}
            failLabel={
              staff
                ? "AML MATCH active — apply will be blocked (409)"
                : "A background check needs review before you can apply"
            }
          />
          <GateRow
            ok={assessment.gates.kycComplete}
            okLabel={staff ? "KYC pack verified" : "Documents verified"}
            failLabel={
              staff
                ? `KYC incomplete — ${assessment.gates.missingKycDocs.length} missing, ${assessment.gates.rejectedKycDocs.length} rejected`
                : `${assessment.gates.missingKycDocs.length} document(s) still needed`
            }
          />
        </div>
      )}

      {/* Anomaly flags are underwriting signals — staff only. */}
      {staff && assessment.anomalies.length > 0 && (
        <AnomalyList anomalies={assessment.anomalies} />
      )}

      {/* Context echo — diagnostic, staff only. */}
      {staff && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-subtle border-t border-default pt-2 font-mono">
          <span>
            score: {assessment.context.creditScore ?? "—"}
            {assessment.context.tier && ` (${assessment.context.tier})`}
          </span>
          <span>·</span>
          <span>active loans: {assessment.context.existingActiveLoans}</span>
          <span>·</span>
          <span>income: {formatMoney(assessment.context.monthlyIncome)}</span>
          <span>·</span>
          <span>age: {assessment.applicantAge}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Statistical + heuristic flags. Same treatment as the dry-run panel: a
 * lone INSUFFICIENT_BASELINE is diagnostic noise on a young product, so
 * it renders as a muted hint rather than as a finding.
 */
function AnomalyList({ anomalies }: { anomalies: AnomalyFlag[] }) {
  const realFlags = anomalies.filter((a) => a.code !== "INSUFFICIENT_BASELINE");
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
          <li
            key={`${flag.code}-${flag.observed ?? 0}`}
            className={`rounded border ${SEVERITY[flag.severity].color} px-2 py-1.5 text-[11px] flex items-start gap-2`}
          >
            <span className="text-[9px] font-mono uppercase tracking-wider mt-0.5 shrink-0">
              {SEVERITY[flag.severity].label}
            </span>
            <span className="flex-1">{flag.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  low: { color: "text-fg bg-surface-2 border-default", label: "Low" },
};

const VERDICT_META = {
  APPROVE: {
    label: "Likely approve",
    borrowerLabel: "Looks good",
    badge: "Auto-approve likely",
    borrowerBadge: "Likely to qualify",
    Icon: ThumbsUp,
    iconClass: "text-success",
    borderClass: "border-success/30",
    bgClass: "bg-success/[0.06]",
    badgeVariant: "success" as const,
  },
  REVIEW: {
    label: "Manual review needed",
    borrowerLabel: "Needs a closer look",
    badge: "Manual review",
    borrowerBadge: "Officer review",
    Icon: AlertTriangle,
    iconClass: "text-warning",
    borderClass: "border-warning/30",
    bgClass: "bg-warning/[0.06]",
    badgeVariant: "warning" as const,
  },
  REJECT: {
    label: "Likely reject",
    borrowerLabel: "Unlikely on these terms",
    badge: "Auto-reject likely",
    borrowerBadge: "Unlikely to qualify",
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
