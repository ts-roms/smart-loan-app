import { TIER_FEATURES, TIER_SEATS } from "@loan/licensing/browser";
import type { LicenseFeatureFlag, LicenseTier } from "@loan/shared-types";
import type { Metadata } from "next";
import Link from "next/link";

/**
 * Pricing — SERVER COMPONENT, and the page where the shared-library
 * story is actually tested (§39).
 *
 * Two workspace libraries are consumed here and both work under RSC
 * without modification:
 *
 *   @loan/licensing/browser  the tier→feature catalog and seat caps.
 *   @loan/shared-types       LicenseTier / LicenseFeatureFlag.
 *
 * Neither needed `"use client"`, because neither contains a component.
 * That is the whole rule, and it is worth stating plainly since it is
 * the opposite of what happened with @loan/ui: RSC compatibility is not
 * about what a library *is*, it is about whether its module graph
 * touches React state. `@loan/licensing/browser` is data and types;
 * `@loan/shared-types` is types only. Both are inert.
 *
 * `@loan/licensing`'s package.json `exports` map matters here — the
 * root entry re-exports the Ed25519 verifier, which imports
 * `node:crypto`. In a Server Component that would now *work*, which is
 * exactly the trap: importing from "@loan/licensing" instead of
 * "@loan/licensing/browser" would compile clean on the server and then
 * fail the moment anything downstream became a Client Component. The
 * `scope:` axis in eslint.config.mjs does not catch it either, since
 * both entries belong to the same project. Keeping the /browser
 * subpath is not optional.
 *
 * The tier metadata still comes straight from the licensing library so
 * this page can never drift from what the license tokens actually
 * unlock — change features.ts and the marketing site reflects it on the
 * next deploy. Under Next that sentence gains a footnote: "next
 * deploy" now means the static render at build time, so the page is
 * baked. Same practical behaviour as the Vite bundle it replaces.
 */

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "On-prem perpetual licence pricing and hosted subscription pricing per tier, with the full feature comparison.",
};

interface TierPlan {
  tier: LicenseTier;
  tagline: string;
  bestFor: string;
  onPremPrice: string;
  onPremCadence: string;
  hostedPrice: string;
  hostedCadence: string;
  recommended?: boolean;
}

/*
 * Prices below are placeholders the operator should set before launch.
 * We deliberately don't make them config — public-facing pricing is a
 * real business decision that deserves a code review, not an env var.
 */
const PLANS: TierPlan[] = [
  {
    tier: "BASIC",
    tagline: "Get lending running",
    bestFor: "Small cooperatives, single branch, < 200 members",
    onPremPrice: "₱120,000",
    onPremCadence: "one-time + ₱24,000/yr support",
    hostedPrice: "₱4,500",
    hostedCadence: "/ month",
  },
  {
    tier: "PROFESSIONAL",
    tagline: "Add servicing + compliance",
    bestFor: "Growing cooperatives with formal collections + reporting needs",
    onPremPrice: "₱280,000",
    onPremCadence: "one-time + ₱56,000/yr support",
    hostedPrice: "₱11,000",
    hostedCadence: "/ month",
    recommended: true,
  },
  {
    tier: "ENTERPRISE",
    tagline: "Full stack — accounting, cooperative, AI",
    bestFor: "Established cooperatives, multi-branch, regulated reporting",
    onPremPrice: "₱650,000",
    onPremCadence: "one-time + ₱130,000/yr support",
    hostedPrice: "₱28,000",
    hostedCadence: "/ month",
  },
];

/**
 * Human-readable group names for the feature flags.
 *
 * Typed as `LicenseFeatureFlag[]` rather than `string[]` — a small
 * improvement the migration made possible for free, since
 * @loan/shared-types was already a dependency for `LicenseTier`. A
 * flag renamed in libs/licensing now fails this app's typecheck
 * instead of silently rendering a dash in every column.
 */
const FEATURE_GROUPS: Array<{ title: string; flags: LicenseFeatureFlag[] }> = [
  {
    title: "Core lending",
    flags: ["core.customers", "core.loans", "core.kyc", "core.scoring"],
  },
  {
    title: "Servicing",
    flags: [
      "servicing.collections",
      "servicing.demand_letters",
      "servicing.repossession",
      "servicing.lease",
    ],
  },
  {
    title: "Accounting",
    flags: [
      "accounting.gl",
      "accounting.periods",
      "accounting.reconciliation",
      "accounting.ecl",
    ],
  },
  {
    title: "Cooperative",
    flags: [
      "cooperative.contributions",
      "cooperative.savings",
      "cooperative.funds",
    ],
  },
  {
    title: "Compliance",
    flags: ["compliance.dorsi", "compliance.annual_docs", "compliance.reports"],
  },
  {
    title: "Intelligence",
    flags: [
      "intel.ai_assistant",
      "intel.id_ocr",
      "intel.face_match",
      "intel.anomaly_flags",
    ],
  },
  {
    title: "Bulk operations",
    flags: ["bulk.customers", "bulk.users", "bulk.payments"],
  },
];

const FLAG_LABELS: Record<string, string> = {
  "core.customers": "Customer management",
  "core.loans": "Loan products + applications",
  "core.kyc": "KYC submissions + review",
  "core.scoring": "Credit scoring (300–850)",
  "servicing.collections": "Collections queue + PTP",
  "servicing.demand_letters": "Demand letters",
  "servicing.repossession": "Repossession workflow",
  "servicing.lease": "Lease-to-own",
  "accounting.gl": "General ledger (auto-posting)",
  "accounting.periods": "Period close + reopen",
  "accounting.reconciliation": "Bank reconciliation",
  "accounting.ecl": "IFRS-9 ECL provisioning",
  "cooperative.contributions": "Member contributions",
  "cooperative.savings": "Savings + withdrawals",
  "cooperative.funds": "Fund management",
  "compliance.dorsi": "DORSI screening",
  "compliance.annual_docs": "Annual documents",
  "compliance.reports": "BSP reports",
  "intel.ai_assistant": "Local LLM assistant",
  "intel.id_ocr": "In-browser ID OCR",
  "intel.face_match": "Selfie ↔ ID face match",
  "intel.anomaly_flags": "Anomaly + risk flagger",
  "bulk.customers": "Bulk customer import",
  "bulk.users": "Bulk user onboarding",
  "bulk.payments": "Bulk payment recording",
};

export default function PricingPage() {
  return (
    <div>
      <section className="border-b border-border px-6 pb-10 pt-[60px] text-center">
        <div className="mx-auto max-w-[720px] px-6 py-6">
          <h1 className="m-0 mb-4 text-[40px] tracking-[-0.8px]">Pricing</h1>
          <p className="m-0 text-[17px] text-fg-dim">
            On-prem is one-time. Hosted is monthly. Both unlock the same
            features per tier — the difference is who runs the infrastructure.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-shell px-6 py-[60px]">
        <div className="mb-[60px] grid grid-cols-3 gap-5">
          {PLANS.map((plan) => (
            <PlanCard key={plan.tier} plan={plan} />
          ))}
        </div>

        <FeatureMatrix />
        <CallSalesBanner />
      </section>
    </div>
  );
}

function PlanCard({ plan }: { plan: TierPlan }) {
  const seats = TIER_SEATS[plan.tier];
  const featureCount = TIER_FEATURES[plan.tier].length;
  return (
    <div
      className={`relative rounded-xl border bg-bg-elev p-7 ${
        plan.recommended ? "border-accent" : "border-border"
      }`}
    >
      {plan.recommended && (
        <div className="absolute -top-[10px] right-5 rounded bg-accent-strong px-[10px] py-[3px] text-[11px] font-semibold tracking-[0.3px] text-white">
          MOST POPULAR
        </div>
      )}
      <div className="mb-1 text-xs uppercase tracking-[0.5px] text-fg-muted">
        {plan.tier}
      </div>
      <h3 className="m-0 mb-1.5 text-[22px] text-fg">{plan.tagline}</h3>
      <p className="m-0 mb-6 min-h-9 text-[13px] text-fg-dim">{plan.bestFor}</p>

      <div className="mb-3 rounded-lg border border-border bg-bg p-4">
        <div className="mb-1 text-[11px] uppercase tracking-[0.5px] text-accent">
          On-prem (recommended)
        </div>
        <div className="text-[28px] font-bold tracking-[-0.5px]">
          {plan.onPremPrice}
        </div>
        <div className="text-xs text-fg-muted">{plan.onPremCadence}</div>
      </div>

      <div className="mb-5 rounded-lg border border-border bg-bg p-4 opacity-85">
        <div className="mb-1 text-[11px] uppercase tracking-[0.5px] text-fg-muted">
          Hosted
        </div>
        <div className="text-xl font-semibold text-fg-dim">
          {plan.hostedPrice}
          <span className="text-[13px] font-normal text-fg-muted">
            {" "}
            {plan.hostedCadence}
          </span>
        </div>
      </div>

      <ul className="m-0 mb-6 list-none p-0 text-[13px] text-fg-dim">
        <li>· {featureCount} features unlocked</li>
        <li>
          · {seats === 0 ? "Unlimited" : seats} staff seats
          {seats === 0 ? "" : " (soft cap)"}
        </li>
        <li>· Full source code access (on-prem)</li>
        <li>· Audit log + compliance reports</li>
      </ul>

      <Link href="/contact" className="btn-primary block w-full text-center">
        Request a license
      </Link>
    </div>
  );
}

function FeatureMatrix() {
  return (
    <div className="mb-10 rounded-xl border border-border bg-bg-elev p-8">
      <h2 className="m-0 mb-2 text-[22px]">Feature comparison</h2>
      <p className="m-0 mb-6 text-sm text-fg-dim">
        What each tier unlocks. Higher tiers include everything below.
      </p>

      {/*
        overflow-x-auto is new. The Vite version let the table set the
        page's minimum width, which on a phone made the whole document
        scroll sideways — nav and footer included. Not a migration
        artefact, just a bug that was visible while checking parity.
      */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={TH}>Feature</th>
              <th className={`${TH} text-center`}>BASIC</th>
              <th className={`${TH} text-center`}>PROFESSIONAL</th>
              <th className={`${TH} text-center`}>ENTERPRISE</th>
            </tr>
          </thead>
          <tbody>
            {FEATURE_GROUPS.map((group) => (
              <FeatureGroupRows key={group.title} group={group} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeatureGroupRows({
  group,
}: {
  group: { title: string; flags: LicenseFeatureFlag[] };
}) {
  const basicSet = new Set<string>(TIER_FEATURES.BASIC);
  const proSet = new Set<string>(TIER_FEATURES.PROFESSIONAL);
  const entSet = new Set<string>(TIER_FEATURES.ENTERPRISE);

  return (
    <>
      <tr>
        <td
          colSpan={4}
          className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-[0.5px] text-accent"
        >
          {group.title}
        </td>
      </tr>
      {group.flags.map((flag) => (
        <tr key={flag} className="border-t border-border">
          <td className={`${TD} text-fg`}>{FLAG_LABELS[flag] ?? flag}</td>
          <td className={`${TD} text-center`}>
            <Check on={basicSet.has(flag)} />
          </td>
          <td className={`${TD} text-center`}>
            <Check on={proSet.has(flag)} />
          </td>
          <td className={`${TD} text-center`}>
            <Check on={entSet.has(flag)} />
          </td>
        </tr>
      ))}
    </>
  );
}

function Check({ on }: { on: boolean }) {
  return on ? (
    <span className="text-base text-success">✓</span>
  ) : (
    <span className="text-fg-muted">—</span>
  );
}

function CallSalesBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-6 rounded-xl border border-border bg-bg-elev p-8">
      <div className="max-w-[560px]">
        <h3 className="m-0 mb-2 text-lg">Multi-branch? Custom integrations?</h3>
        <p className="m-0 text-sm leading-relaxed text-fg-dim">
          We do custom installs, data migrations, and per-cooperative training.
          Pricing depends on scope — talk to us first, we&apos;ll give you a
          real number.
        </p>
      </div>
      <Link href="/contact" className="btn-secondary">
        Talk to sales →
      </Link>
    </div>
  );
}

const TH =
  "px-3 py-2.5 text-xs font-medium uppercase tracking-[0.5px] text-fg-muted";
const TD = "px-3 py-2.5 text-[13px]";
