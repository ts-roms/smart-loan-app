import {
  useCheckDorsiLoan,
  useCustomer,
  useDorsiForCustomer,
} from "@loan/api-client";
import type { DorsiLoanCheck } from "@loan/shared-types";
import { monthlyPayment } from "@loan/loans";
import { formatMoney } from "@loan/shared-utils";
import { AlertTriangle, ShieldAlert, TrendingDown, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Default debt-to-income ceiling for the "safe principal" hint. 50% is a
 * common PH cooperative threshold (FRD §3.4 implied). It's a *soft*
 * guardrail — the officer can still submit a higher principal; the
 * decisioning engine has the final say.
 */
const DEFAULT_DTI_CEILING = 0.5;

export interface AffordabilityGuardrailsProps {
  customerId: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a percentage (e.g. 24 for 24% APR). */
  ratePercent: number;
  /** Override default 50% DTI ceiling — pass for stricter / looser products. */
  dtiCeiling?: number;
}

/**
 * Affordability + DORSI cap projection. Sits below the principal/term/rate
 * row. Two sub-panels:
 *
 *   • Affordability — computes the monthly EMI client-side and shows it
 *     as a % of the borrower's monthly income (DTI). Also derives the
 *     "max safe principal" at the chosen term/rate by inverting the EMI
 *     formula against the DTI ceiling.
 *
 *   • DORSI projection — only rendered when the customer is DORSI-tagged.
 *     Calls POST /dorsi/check on a 400ms debounce to project aggregate +
 *     individual utilization after this loan. Highlights board-approval
 *     threshold breaches inline.
 */
export function AffordabilityGuardrails({
  customerId,
  principal,
  termMonths,
  ratePercent,
  dtiCeiling = DEFAULT_DTI_CEILING,
}: AffordabilityGuardrailsProps) {
  const customer = useCustomer(customerId);
  const dorsi = useDorsiForCustomer(customerId);
  const dorsiCheck = useCheckDorsiLoan();
  const [dorsiResult, setDorsiResult] = useState<DorsiLoanCheck | null>(null);

  const income = Number(customer.data?.monthlyIncome ?? 0);
  const annualRate = ratePercent / 100;
  const periodRate = annualRate / 12;

  // Compute affordability metrics. Guard against zero/invalid inputs so
  // the panel still renders meaningful "—" placeholders pre-fill.
  const { emi, dti, maxSafePrincipal } = useMemo(() => {
    if (
      !Number.isFinite(principal) ||
      principal <= 0 ||
      !Number.isFinite(termMonths) ||
      termMonths <= 0 ||
      !Number.isFinite(annualRate) ||
      annualRate < 0
    ) {
      return { emi: 0, dti: 0, maxSafePrincipal: 0 };
    }
    const periodEmi = monthlyPayment(principal, periodRate, termMonths);
    const ratio = income > 0 ? periodEmi / income : 0;
    // Invert EMI formula: principal = emi × ((1+r)^n − 1) / (r × (1+r)^n)
    // The "safe" EMI is `income × dtiCeiling`.
    const safeEmi = income * dtiCeiling;
    let safePrincipal = 0;
    if (safeEmi > 0 && termMonths > 0) {
      if (periodRate === 0) {
        safePrincipal = safeEmi * termMonths;
      } else {
        const onePlusRPowN = Math.pow(1 + periodRate, termMonths);
        safePrincipal =
          (safeEmi * (onePlusRPowN - 1)) / (periodRate * onePlusRPowN);
      }
    }
    return { emi: periodEmi, dti: ratio, maxSafePrincipal: safePrincipal };
  }, [principal, termMonths, periodRate, annualRate, income, dtiCeiling]);

  // ── DORSI debounced projection ─────────────────────────────────
  // Re-run when principal changes (the user is sliding it around) but
  // wait 400ms so we don't pelt the API on every keystroke.
  const isDorsi = Boolean(dorsi.data?.active);
  useEffect(() => {
    if (!isDorsi || !customerId || principal <= 0) {
      setDorsiResult(null);
      return;
    }
    const timer = window.setTimeout(() => {
      dorsiCheck.mutate(
        { customerId, principal },
        {
          onSuccess: (data) => setDorsiResult(data),
          onError: () => setDorsiResult(null),
        },
      );
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, principal, isDorsi]);

  if (!customerId || customer.isLoading) return null;

  const dtiTone =
    dti === 0
      ? "info"
      : dti <= 0.3
        ? "good"
        : dti <= dtiCeiling
          ? "warn"
          : "bad";
  const exceedsSafe = principal > maxSafePrincipal && maxSafePrincipal > 0;

  return (
    <div className="space-y-2">
      {/* Affordability strip */}
      <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Wallet className="h-4 w-4 text-sky-300" />
            <span className="font-medium">Affordability</span>
            <span className="text-[10px] text-white/45 uppercase tracking-wider">
              · DTI ceiling {(dtiCeiling * 100).toFixed(0)}%
            </span>
          </div>
          {income === 0 && (
            <span className="text-[10px] text-amber-300 inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              No income on file
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <MiniMetric
            label="Monthly EMI"
            value={emi > 0 ? formatMoney(emi) : "—"}
            tone="info"
          />
          <MiniMetric
            label="DTI"
            value={dti > 0 ? `${(dti * 100).toFixed(1)}%` : "—"}
            tone={dtiTone}
            hint={
              income > 0
                ? `EMI vs ₱${formatMoney(income).replace(/^₱/, "")}/mo`
                : undefined
            }
          />
          <MiniMetric
            label="Max safe principal"
            value={maxSafePrincipal > 0 ? formatMoney(maxSafePrincipal) : "—"}
            tone={exceedsSafe ? "bad" : "good"}
            hint={`at ${termMonths}mo · ${ratePercent.toFixed(1)}%`}
          />
          <MiniMetric
            label="Headroom"
            value={
              maxSafePrincipal > 0
                ? formatMoney(maxSafePrincipal - principal)
                : "—"
            }
            tone={exceedsSafe ? "bad" : "good"}
          />
        </div>
        {exceedsSafe && (
          <div className="flex items-start gap-1.5 text-[11px] text-rose-200">
            <TrendingDown className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Principal exceeds the safe ceiling at{" "}
              {(dtiCeiling * 100).toFixed(0)}% DTI by{" "}
              <strong className="font-mono">
                {formatMoney(principal - maxSafePrincipal)}
              </strong>
              . Consider lowering principal, lengthening term, or adding a
              co-maker.
            </span>
          </div>
        )}
        {!exceedsSafe && dti > 0 && dti <= 0.3 && (
          <div className="text-[11px] text-emerald-200">
            DTI is comfortable — borrower has{" "}
            <strong className="font-mono">
              {formatMoney(maxSafePrincipal - principal)}
            </strong>{" "}
            of additional principal headroom at this term/rate.
          </div>
        )}
      </div>

      {/* DORSI projection (only if tagged) */}
      {isDorsi && dorsiResult && (
        <div
          className={`rounded-md border p-3 space-y-2 ${
            dorsiResult.status === "BOARD_REQUIRED"
              ? "border-amber-400/30 bg-amber-500/[0.08]"
              : "border-white/10 bg-white/[0.02]"
          }`}
        >
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 text-amber-300" />
              <span className="font-medium">DORSI cap projection</span>
              <span className="text-[10px] text-white/45 uppercase tracking-wider">
                FRD §3.10
              </span>
            </div>
            <span
              className={`text-[10px] uppercase tracking-wider ${
                dorsiResult.status === "BOARD_REQUIRED"
                  ? "text-amber-300"
                  : "text-emerald-300"
              }`}
            >
              {dorsiResult.status === "BOARD_REQUIRED"
                ? "Board approval required"
                : "Within cap"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <MiniMetric
              label="Aggregate now"
              value={formatMoney(dorsiResult.aggregateOutstanding)}
              tone="info"
              hint={`cap ${formatMoney(dorsiResult.aggregateCap)}`}
            />
            <MiniMetric
              label="After this loan"
              value={`${(dorsiResult.projectedAggregateUtilization * 100).toFixed(1)}%`}
              tone={
                dorsiResult.projectedAggregateUtilization >= 1
                  ? "bad"
                  : dorsiResult.projectedAggregateUtilization >= 0.9
                    ? "warn"
                    : "good"
              }
              hint="aggregate cap"
            />
            <MiniMetric
              label="Individual now"
              value={formatMoney(dorsiResult.individualOutstanding)}
              tone="info"
              hint={`cap ${formatMoney(dorsiResult.individualCap)}`}
            />
            <MiniMetric
              label="After this loan"
              value={`${(dorsiResult.projectedIndividualUtilization * 100).toFixed(1)}%`}
              tone={
                dorsiResult.projectedIndividualUtilization >= 1
                  ? "bad"
                  : dorsiResult.projectedIndividualUtilization >= 0.9
                    ? "warn"
                    : "good"
              }
              hint="per-borrower cap"
            />
          </div>
          {dorsiResult.message && (
            <p className="text-[11px] text-white/70">{dorsiResult.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "info" | "good" | "warn" | "bad";
  hint?: string;
}) {
  const toneClass = {
    info: "text-white/85",
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
  }[tone];
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className={`text-xs font-medium font-mono ${toneClass}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[9px] text-white/35 mt-0.5 truncate">{hint}</div>
      )}
    </div>
  );
}
