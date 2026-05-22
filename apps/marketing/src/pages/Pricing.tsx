import {
  TIER_FEATURES,
  TIER_SEATS,
  type LicenseTier,
} from "@loan/licensing/browser";
import { Link } from "react-router-dom";

import { btnPrimary, btnSecondary, container } from "../App";

/**
 * Pricing page. On-prem-first: the headline prices are the perpetual
 * on-prem license fees. Hosted prices appear underneath as the second
 * column.
 *
 * Tier metadata (feature lists, seat caps) comes straight from
 * @loan/licensing so this page can never drift from what the license
 * tokens actually unlock — change features.ts and the marketing site
 * reflects it on the next deploy.
 *
 * Prices below are placeholders the operator should set before
 * launch. We deliberately don't make them config — public-facing
 * pricing is a real business decision that deserves a code review,
 * not an env var.
 */

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

/** Human-readable group names for the feature flags. */
const FEATURE_GROUPS: Array<{ title: string; flags: string[] }> = [
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

export function Pricing() {
  return (
    <div>
      <section
        style={{
          padding: "60px 24px 40px",
          textAlign: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ ...container, maxWidth: 720 }}>
          <h1
            style={{
              fontSize: 40,
              margin: "0 0 16px",
              letterSpacing: -0.8,
            }}
          >
            Pricing
          </h1>
          <p style={{ color: "var(--text-dim)", fontSize: 17, margin: 0 }}>
            On-prem is one-time. Hosted is monthly. Both unlock the same
            features per tier — the difference is who runs the infrastructure.
          </p>
        </div>
      </section>

      <section style={{ padding: "60px 24px", ...container }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 20,
            marginBottom: 60,
          }}
        >
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
      style={{
        padding: 28,
        background: "var(--bg-elev)",
        border: plan.recommended
          ? "1px solid var(--accent)"
          : "1px solid var(--border)",
        borderRadius: 12,
        position: "relative",
      }}
    >
      {plan.recommended && (
        <div
          style={{
            position: "absolute",
            top: -10,
            right: 20,
            background: "var(--accent-strong)",
            color: "white",
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 4,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          MOST POPULAR
        </div>
      )}
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {plan.tier}
      </div>
      <h3
        style={{
          fontSize: 22,
          margin: "0 0 6px",
          color: "var(--text)",
        }}
      >
        {plan.tagline}
      </h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-dim)",
          margin: "0 0 24px",
          minHeight: 36,
        }}
      >
        {plan.bestFor}
      </p>

      <div
        style={{
          padding: 16,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--accent)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 4,
          }}
        >
          On-prem (recommended)
        </div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: -0.5,
          }}
        >
          {plan.onPremPrice}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {plan.onPremCadence}
        </div>
      </div>

      <div
        style={{
          padding: 16,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          marginBottom: 20,
          opacity: 0.85,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 4,
          }}
        >
          Hosted
        </div>
        <div
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: "var(--text-dim)",
          }}
        >
          {plan.hostedPrice}
          <span
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              fontWeight: 400,
            }}
          >
            {" "}
            {plan.hostedCadence}
          </span>
        </div>
      </div>

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 24px",
          fontSize: 13,
          color: "var(--text-dim)",
        }}
      >
        <li>· {featureCount} features unlocked</li>
        <li>
          · {seats === 0 ? "Unlimited" : seats} staff seats
          {seats === 0 ? "" : " (soft cap)"}
        </li>
        <li>· Full source code access (on-prem)</li>
        <li>· Audit log + compliance reports</li>
      </ul>

      <Link
        to="/contact"
        style={{
          ...btnPrimary,
          width: "100%",
          textAlign: "center",
          boxSizing: "border-box",
        }}
      >
        Request a license
      </Link>
    </div>
  );
}

function FeatureMatrix() {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 32,
        marginBottom: 40,
      }}
    >
      <h2
        style={{
          fontSize: 22,
          margin: "0 0 8px",
        }}
      >
        Feature comparison
      </h2>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 14,
          margin: "0 0 24px",
        }}
      >
        What each tier unlocks. Higher tiers include everything below.
      </p>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <th style={th}>Feature</th>
            <th style={{ ...th, textAlign: "center" }}>BASIC</th>
            <th style={{ ...th, textAlign: "center" }}>PROFESSIONAL</th>
            <th style={{ ...th, textAlign: "center" }}>ENTERPRISE</th>
          </tr>
        </thead>
        <tbody>
          {FEATURE_GROUPS.map((group) => (
            <FeatureGroupRows key={group.title} group={group} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeatureGroupRows({
  group,
}: {
  group: { title: string; flags: string[] };
}) {
  const basicSet = new Set<string>(TIER_FEATURES.BASIC);
  const proSet = new Set<string>(TIER_FEATURES.PROFESSIONAL);
  const entSet = new Set<string>(TIER_FEATURES.ENTERPRISE);

  return (
    <>
      <tr>
        <td
          colSpan={4}
          style={{
            padding: "16px 12px 6px",
            fontSize: 11,
            color: "var(--accent)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 600,
          }}
        >
          {group.title}
        </td>
      </tr>
      {group.flags.map((flag) => (
        <tr key={flag} style={{ borderTop: "1px solid var(--border)" }}>
          <td style={{ ...td, color: "var(--text)" }}>
            {FLAG_LABELS[flag] ?? flag}
          </td>
          <td style={{ ...td, textAlign: "center" }}>
            <Check on={basicSet.has(flag)} />
          </td>
          <td style={{ ...td, textAlign: "center" }}>
            <Check on={proSet.has(flag)} />
          </td>
          <td style={{ ...td, textAlign: "center" }}>
            <Check on={entSet.has(flag)} />
          </td>
        </tr>
      ))}
    </>
  );
}

function Check({ on }: { on: boolean }) {
  return on ? (
    <span style={{ color: "var(--success)", fontSize: 16 }}>✓</span>
  ) : (
    <span style={{ color: "var(--text-muted)" }}>—</span>
  );
}

function CallSalesBanner() {
  return (
    <div
      style={{
        padding: 32,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        flexWrap: "wrap",
      }}
    >
      <div style={{ maxWidth: 560 }}>
        <h3 style={{ fontSize: 18, margin: "0 0 8px" }}>
          Multi-branch? Custom integrations?
        </h3>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: 14,
            margin: 0,
            lineHeight: 1.6,
          }}
        >
          We do custom installs, data migrations, and per-cooperative training.
          Pricing depends on scope — talk to us first, we'll give you a real
          number.
        </p>
      </div>
      <Link to="/contact" style={btnSecondary}>
        Talk to sales →
      </Link>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 12,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
};
