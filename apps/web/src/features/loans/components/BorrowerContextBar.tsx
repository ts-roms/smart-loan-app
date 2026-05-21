import {
  useCustomer,
  useCustomerScore,
  useCustomerSummary,
  useDorsiForCustomer,
  useRepeatEligibility,
} from "@loan/api-client";
import { Badge } from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Repeat,
  ShieldAlert,
  User,
  XCircle,
} from "lucide-react";

/**
 * Snapshot of the borrower shown at the top of NewLoanDialog as soon as
 * a customer is selected. Replaces the "open the customer in another tab
 * to check income / KYC / history" tax with a single glance.
 *
 * Data sources (all already in api-client):
 *   - useCustomer            : monthly income, KYC status
 *   - useCustomerScore       : credit score + tier (null pre-survey)
 *   - useCustomerSummary     : active loans, outstanding principal
 *   - useRepeatEligibility   : FRD §3.1.1 repeat-borrower eligibility
 *   - useDorsiForCustomer    : DORSI tag (null if not tagged)
 *
 * Surfacing rules ("traffic lights"):
 *   - Red    : has DEFAULTED / WRITTEN_OFF history, KYC REJECTED
 *   - Amber  : KYC PENDING/NONE, DORSI-tagged, score F, no score yet
 *   - Green  : repeat-eligible + verified KYC + score >= D
 */
export function BorrowerContextBar({ customerId }: { customerId: string }) {
  const customer = useCustomer(customerId);
  const score = useCustomerScore(customerId);
  const summary = useCustomerSummary(customerId);
  const repeat = useRepeatEligibility(customerId);
  const dorsi = useDorsiForCustomer(customerId);

  if (!customerId) return null;

  const c = customer.data;
  const s = score.data;
  const r = repeat.data;
  const d = dorsi.data;
  const loading =
    customer.isLoading ||
    score.isLoading ||
    repeat.isLoading ||
    summary.isLoading ||
    dorsi.isLoading;

  if (loading) {
    return (
      <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-xs text-white/55">
        Loading borrower context…
      </div>
    );
  }

  if (!c) {
    return (
      <div className="rounded-md border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-200">
        Customer not found.
      </div>
    );
  }

  // ─── Derive surfacing flags ─────────────────────────────────────
  const hasPriorDefault =
    (r?.defaultedLoansCount ?? 0) > 0 || (r?.writtenOffLoansCount ?? 0) > 0;
  const kycVerified = c.kycStatus === "VERIFIED";
  const kycRejected = c.kycStatus === "REJECTED";
  const isDorsi = Boolean(d?.active);
  const isRepeat = r?.eligible ?? false;
  const tier = s?.tier ?? null;

  return (
    <div className="rounded-md border border-white/10 bg-gradient-to-br from-sky-500/[0.04] to-white/[0.02] p-3 space-y-2.5">
      {/* Identity row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-8 w-8 rounded-md border border-sky-400/30 bg-sky-500/10 flex items-center justify-center shrink-0">
            <User className="h-4 w-4 text-sky-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {c.firstName} {c.lastName}
            </div>
            <div className="text-[10px] text-white/55 truncate">
              {c.phone} · {c.employmentStatus.replace("_", " ").toLowerCase()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <KycBadge status={c.kycStatus} />
          {isRepeat && (
            <Badge variant="success" title="Eligible for repeat-loan fast path">
              <Repeat className="h-3 w-3" />
              Repeat
            </Badge>
          )}
          {hasPriorDefault && (
            <Badge
              variant="danger"
              title="Borrower has at least one defaulted or written-off loan"
            >
              <XCircle className="h-3 w-3" />
              Prior default
            </Badge>
          )}
          {isDorsi && (
            <Badge
              variant="warning"
              title={`DORSI ${d?.category} — cap check required before disburse`}
            >
              <ShieldAlert className="h-3 w-3" />
              DORSI · {d?.category.toLowerCase()}
            </Badge>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Metric
          label="Monthly income"
          value={`₱${formatMoney(Number(c.monthlyIncome)).replace(/^₱/, "")}/mo`}
          tone="info"
        />
        <Metric
          label="Credit score"
          value={tier ? `${s?.score ?? "—"} · ${tier}` : "— (no survey)"}
          tone={
            !tier
              ? "warn"
              : tier === "A" || tier === "B"
                ? "good"
                : tier === "F"
                  ? "bad"
                  : "info"
          }
        />
        <Metric
          label="Loan history"
          value={
            r
              ? `${r.closedLoansCount + r.defaultedLoansCount + r.writtenOffLoansCount || 0} prior · ${r.closedLoansCount} closed`
              : "—"
          }
          tone={hasPriorDefault ? "bad" : isRepeat ? "good" : "info"}
        />
        <Metric
          label="Active loans"
          value={
            summary.data
              ? `${summary.data.activeLoansCount} · ${formatMoney(Number(summary.data.outstanding))} out`
              : "—"
          }
          tone={(summary.data?.activeLoansCount ?? 0) > 2 ? "warn" : "info"}
        />
      </div>

      {/* Smart hints — concise, actionable, never blocking */}
      {(kycRejected || hasPriorDefault || isDorsi || !kycVerified || !tier) && (
        <div className="space-y-1 border-t border-white/5 pt-2">
          {kycRejected && (
            <Hint tone="bad" icon={XCircle}>
              KYC REJECTED — fix the rejection reason and re-submit docs before
              applying.
            </Hint>
          )}
          {!kycVerified && !kycRejected && (
            <Hint tone="warn" icon={AlertTriangle}>
              KYC is {c.kycStatus.toLowerCase()} — loan cannot be decided until
              all required docs are VERIFIED.
            </Hint>
          )}
          {hasPriorDefault && (
            <Hint tone="bad" icon={XCircle}>
              {r!.defaultedLoansCount + r!.writtenOffLoansCount} prior loan(s)
              in default / written-off — require higher tier sign-off.
            </Hint>
          )}
          {isDorsi && (
            <Hint tone="warn" icon={ShieldAlert}>
              DORSI cap projection runs at /loans/:id/decide — if approval
              pushes aggregate &gt; 15% of equity, board approval must be
              recorded.
            </Hint>
          )}
          {!tier && (
            <Hint tone="warn" icon={AlertTriangle}>
              No credit-score survey on file — application can proceed but will
              score on behavior signals alone.
            </Hint>
          )}
          {isRepeat && !hasPriorDefault && kycVerified && (
            <Hint tone="good" icon={CheckCircle2}>
              Repeat-borrower fast path eligible · last closed{" "}
              {formatRelativeDate(r?.lastClosedAt)} · KYC re-use allowed.
            </Hint>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "info" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    info: "text-white/85",
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
  }[tone];
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className={`text-xs font-medium font-mono ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function Hint({
  tone,
  icon: Icon,
  children,
}: {
  tone: "good" | "warn" | "bad";
  icon: typeof AlertTriangle;
  children: React.ReactNode;
}) {
  const map = {
    good: "text-emerald-200",
    warn: "text-amber-200",
    bad: "text-rose-200",
  };
  return (
    <div
      className={`flex items-start gap-1.5 text-[11px] leading-snug ${map[tone]}`}
    >
      <Icon className="h-3 w-3 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function KycBadge({
  status,
}: {
  status: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
}) {
  const map = {
    NONE: { variant: "muted" as const, label: "No KYC" },
    PENDING: { variant: "warning" as const, label: "KYC pending" },
    VERIFIED: { variant: "success" as const, label: "KYC verified" },
    REJECTED: { variant: "danger" as const, label: "KYC rejected" },
  };
  const { variant, label } = map[status];
  return (
    <Badge variant={variant} title={`KYC status: ${status}`}>
      <FileCheck2 className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
