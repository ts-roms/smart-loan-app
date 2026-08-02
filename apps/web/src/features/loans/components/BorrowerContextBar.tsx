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
  Briefcase,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCheck2,
  IdCard,
  Repeat,
  ShieldAlert,
  User,
  XCircle,
} from "lucide-react";
import { useState } from "react";

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
  /**
   * Identity + employment stay collapsed by default. This is a context
   * *bar* — the four metrics above are what an officer needs at a glance,
   * and inlining fourteen more fields would bury them. Officers who need
   * to confirm the person or check job tenure open it; nobody else pays
   * for it in vertical space.
   */
  const [showDetails, setShowDetails] = useState(false);

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

      {/* Identity + employment — collapsed by default, see note above */}
      <div className="border-t border-white/5 pt-2">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 text-[11px] text-white/60 hover:text-white/85 transition-colors"
        >
          {showDetails ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {showDetails ? "Hide" : "Show"} borrower &amp; employment details
        </button>

        {showDetails && (
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <DetailGroup icon={IdCard} title="Borrower">
              <Field label="Full name" value={fullName(c)} />
              <Field label="Date of birth" value={formatDob(c.dateOfBirth)} />
              <Field
                label="Civil status"
                value={titleCase(c.civilStatus ?? undefined)}
              />
              <Field
                label="Government ID"
                value={`${c.governmentIdType.replace("_", " ")} · ${c.governmentIdNumber}`}
              />
              <Field label="Mobile" value={c.phone} />
              <Field label="Alt. mobile" value={c.secondaryPhone} />
              <Field label="Email" value={c.email} />
              <Field label="Address" value={formatAddress(c)} />
            </DetailGroup>

            <DetailGroup icon={Briefcase} title="Employment">
              <Field
                label="Status"
                value={titleCase(c.employmentStatus)}
                tone={c.employmentStatus === "UNEMPLOYED" ? "warn" : undefined}
              />
              <Field label="Employer" value={c.employerName} />
              <Field label="Job title" value={c.jobTitle} />
              <Field label="Position" value={c.position} />
              <Field label="Hired" value={formatDob(c.hireDate)} />
              <Field
                label="Regularized"
                value={formatDob(c.regularizationDate)}
                /* Probationary staff are a materially different risk from
                   regularized ones, so call it out rather than leave a gap. */
                tone={c.hireDate && !c.regularizationDate ? "warn" : undefined}
                fallback={c.hireDate ? "not yet regularized" : undefined}
              />
              <Field label="Tenure" value={formatTenure(c)} />
              <Field
                label="Monthly income"
                value={`₱${formatMoney(Number(c.monthlyIncome)).replace(/^₱/, "")}`}
              />
            </DetailGroup>
          </div>
        )}
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

function DetailGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof User;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="h-3 w-3 text-white/45" />
        <span className="text-[9px] uppercase tracking-wider text-white/45">
          {title}
        </span>
      </div>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

/**
 * One label/value row. Renders nothing when there is no value and no
 * fallback — a borrower with no spouse or no second phone shouldn't
 * produce a column of em-dashes for the officer to read past.
 */
function Field({
  label,
  value,
  tone,
  fallback,
}: {
  label: string;
  value?: string | null;
  tone?: "warn";
  fallback?: string;
}) {
  const shown = value?.trim() ? value : fallback;
  if (!shown) return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-snug">
      <dt className="text-white/45 shrink-0 w-[86px]">{label}</dt>
      <dd
        className={`font-mono min-w-0 break-words ${
          tone === "warn" ? "text-amber-300" : "text-white/85"
        }`}
      >
        {shown}
      </dd>
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

/** Customer fields these formatters read. Kept structural so the helpers
 *  don't drag the whole Customer type through the file. */
type BorrowerLike = {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  address?: string | null;
  addressLine2?: string | null;
  barangay?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  hireDate?: string | null;
  yearsAtCurrentJob?: string | number | null;
};

function fullName(c: BorrowerLike): string {
  return [c.firstName, c.middleName, c.lastName, c.suffix]
    .filter((p) => p && String(p).trim())
    .join(" ");
}

/** Date plus age — lending has age floors and ceilings, and computing it
 *  in your head from a birth date is exactly the sort of thing that gets
 *  skipped. */
function formatDob(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const formatted = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const years = yearsSince(d);
  return years === null ? formatted : `${formatted} (${years}y)`;
}

function formatAddress(c: BorrowerLike): string | undefined {
  const parts = [
    c.address,
    c.addressLine2,
    c.barangay,
    c.city,
    c.province,
    c.postalCode,
  ].filter((p) => p && String(p).trim());
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * Prefer the stored `yearsAtCurrentJob` — it is what the officer captured
 * and what scoring uses — and fall back to deriving it from the hire date
 * so a record with one but not the other still says something useful.
 */
function formatTenure(c: BorrowerLike): string | undefined {
  const stated = c.yearsAtCurrentJob;
  if (stated !== null && stated !== undefined && String(stated).trim() !== "") {
    const n = Number(stated);
    if (Number.isFinite(n)) return `${n} yr${n === 1 ? "" : "s"}`;
  }
  if (!c.hireDate) return undefined;
  const years = yearsSince(new Date(c.hireDate));
  return years === null ? undefined : `~${years} yr${years === 1 ? "" : "s"}`;
}

function yearsSince(d: Date): number | null {
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years -= 1;
  return years < 0 ? null : years;
}

function titleCase(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
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
