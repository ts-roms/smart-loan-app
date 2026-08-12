/**
 * Collection priority score — §29.
 *
 * A pure function. Given what is already known about a delinquent
 * account, it answers three questions a collector opening the queue
 * actually has: who do I call first, what do I do with them, and when
 * do I come back.
 *
 * ─── Why this exists ─────────────────────────────────────────────────
 *
 * `overdueQueue` used to sort by `daysOverdue` descending, top to
 * bottom. That ordering has a specific failure: the accounts at the top
 * are the ones that have been failing the longest, which are frequently
 * the ones least likely to pay. A collector working it in order spends
 * the morning on a three-year-old ₱6,000 balance with a disconnected
 * phone and no security, and reaches the ₱380,000 vehicle loan that
 * went 40 days down — reachable, secured, still curable — some time
 * after lunch, if at all.
 *
 * ─── What it is not ──────────────────────────────────────────────────
 *
 * It is not a prediction. The weights in `weights.ts` are uncalibrated
 * priors, and two of §29's eight named inputs have no source in this
 * schema at all (see `UNSOURCED_FACTORS`). The output carries both
 * facts — `missingFactors` on every result, per-factor `source` strings
 * throughout — because a collector who cannot see why an account is #1
 * will ignore the ordering, and should.
 *
 * ─── Reuse ───────────────────────────────────────────────────────────
 *
 * DPD banding comes from `@loan/accounting`'s `agingBucketFor` (§28's
 * seven bands), not a second copy of the thresholds. Balances are
 * computed by `@loan/loans` (`loanBalance`) before they get here — this
 * module takes an already-derived number and never does balance
 * arithmetic of its own.
 */

import { agingBucketFor, type AgingBucket } from "@loan/accounting";

import {
  COLLECTION_PRIORITY_WEIGHTS,
  EXPOSURE_CEILING,
  PRIORITY_FACTOR_LABELS,
  UNSOURCED_FACTORS,
  type PriorityFactorId,
} from "./weights";

// ─── Inputs ────────────────────────────────────────────────────────────

/** Promise-to-pay outcome, mirroring `PromiseStatus` without importing Prisma. */
export type PromiseOutcome = "PROMISED" | "HONORED" | "BROKEN" | "CANCELLED";

/** Credit tier, mirroring `CreditTier` / `@loan/credit-scoring`'s `Tier`. */
export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export interface PriorityPromiseInput {
  status: PromiseOutcome;
  promisedDate: Date;
}

export interface PriorityInput {
  /** Evaluation instant. Passed in, never `new Date()` — this is a pure function. */
  asOf: Date;
  /**
   * Loan status. Only the terminal ones change behaviour: a written-off
   * account is suppressed rather than scored (see `SUPPRESSED_STATUSES`).
   */
  loanStatus: string;
  /** Days past the earliest unpaid instalment's due date. */
  daysOverdue: number;
  /** Outstanding balance, from `loanBalance` — not recomputed here. */
  outstanding: number;
  /** Latest scorecard tier, or null when the customer was never scored. */
  riskGrade: RiskGrade | null;
  /** Every promise-to-pay on this loan. Order irrelevant. */
  promises: readonly PriorityPromiseInput[];
  contact: {
    phone: string | null;
    secondaryPhone: string | null;
    email: string | null;
    /** Timestamp of the most recent logged collection note, if any. */
    lastContactAt: Date | null;
  };
  history: {
    /** Prior loans that reached CLOSED — paid off. */
    priorLoansClosed: number;
    /** Prior loans that reached DEFAULTED or WRITTEN_OFF. */
    priorLoansDefaulted: number;
  };
  /** Appraised value of vehicle or property security; null when unsecured. */
  collateralValue: number | null;
}

// ─── Outputs ───────────────────────────────────────────────────────────

export interface PriorityFactor {
  factorId: PriorityFactorId;
  label: string;
  /** Share of the total score this factor can contribute (0..1). */
  weight: number;
  /** How strongly it fired, 0..1. */
  strength: number;
  /** `weight * strength * 100`, rounded — its actual contribution. */
  points: number;
  /** Plain-language reason. This is what makes the ordering arguable. */
  source: string;
}

/**
 * What to do with the account. Deliberately coarse — these map onto
 * things the system can already do (notes, PTPs, demand letters,
 * repossession cases) rather than inventing a workflow.
 */
export type RecommendedAction =
  | "AWAIT_PROMISE"
  | "SEND_REMINDER"
  | "CALL_BORROWER"
  | "FIELD_VISIT"
  | "ISSUE_DEMAND_LETTER"
  | "FINAL_DEMAND"
  | "INITIATE_REPOSSESSION"
  | "ESCALATE_LEGAL"
  | "MONITOR_RECOVERY_ONLY";

export type RecommendedChannel = "SMS" | "EMAIL" | "PHONE" | "FIELD" | "LETTER";

/** Coarse band for colour-coding a queue. Derived from the score alone. */
export type PriorityBand = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface PriorityResult {
  /** 0–100. Higher means work it sooner. */
  score: number;
  band: PriorityBand;
  /** §28 aging band, reused rather than re-derived. */
  agingBucket: AgingBucket;
  factors: PriorityFactor[];
  action: RecommendedAction;
  /** Why that action, in one sentence. */
  actionReason: string;
  channel: RecommendedChannel;
  channelReason: string;
  nextFollowUpDate: Date;
  followUpReason: string;
  /**
   * True when the account is terminal and deliberately pushed down the
   * queue rather than scored on its merits.
   */
  suppressed: boolean;
  /** §29 inputs with no source in this schema. Always populated. */
  missingFactors: ReadonlyArray<{ requirement: string; reason: string }>;
}

// ─── Policy constants ──────────────────────────────────────────────────

/**
 * Statuses that leave the calling queue.
 *
 * A written-off account is not worked by phone — the lender has already
 * given up collecting and taken the P&L hit. Recovery is still POSSIBLE
 * (`PAYABLE_STATUSES` accepts a payment on a written-off loan, and it
 * posts to Bad Debt Recovery), so the account is not hidden; it is
 * suppressed to the bottom with its reason attached. Hiding it would
 * lose a real recovery channel; leaving it to compete on DPD would put
 * the least workable accounts in the book at the top of the queue,
 * which is the exact failure this score exists to fix.
 */
const SUPPRESSED_STATUSES = new Set(["WRITTEN_OFF", "CLOSED", "CANCELLED"]);

/**
 * Score ceiling for a suppressed account. Below every LOW band account
 * that is still genuinely workable, but non-zero and still ordered
 * among its peers by balance, so a ₱400,000 write-off outranks a
 * ₱4,000 one if anyone does work the recovery list.
 */
const SUPPRESSED_SCORE_CEILING = 5;

/** Strength each aging band contributes to `delinquencyDepth`. */
const DEPTH_BY_BUCKET: Record<AgingBucket, number> = {
  CURRENT: 0,
  D_1_30: 0.2,
  D_31_60: 0.45,
  D_61_90: 0.65,
  D_91_120: 0.8,
  D_121_180: 0.9,
  /**
   * Beyond 180 days the curve flattens rather than continuing to climb.
   * It stays the highest band — these accounts are the most impaired —
   * but a 400-day account and a 4,000-day one are not meaningfully
   * different collection problems, and letting depth run unbounded
   * would rebuild the sort-by-DPD ordering inside the score itself.
   */
  D_180_PLUS: 1,
};

/** Strength each risk grade contributes. Worse grade, higher priority. */
const RISK_GRADE_STRENGTH: Record<RiskGrade, number> = {
  A: 0.1,
  B: 0.25,
  C: 0.5,
  D: 0.75,
  F: 1,
};

/** Days until the next touch, per recommended action. */
const FOLLOW_UP_DAYS: Record<RecommendedAction, number> = {
  AWAIT_PROMISE: 1, // day after the promise falls due
  SEND_REMINDER: 7,
  CALL_BORROWER: 5,
  FIELD_VISIT: 7,
  ISSUE_DEMAND_LETTER: 10,
  FINAL_DEMAND: 14,
  INITIATE_REPOSSESSION: 14,
  ESCALATE_LEGAL: 30,
  MONITOR_RECOVERY_ONLY: 90,
};

// ─── Scoring ───────────────────────────────────────────────────────────

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Score one delinquent account.
 *
 * Every branch records a `source` string. That is not decoration: the
 * ordering is the product, and an ordering nobody can interrogate gets
 * overridden by whoever is holding the phone list.
 */
export function computeCollectionPriority(
  input: PriorityInput,
): PriorityResult {
  const agingBucket = agingBucketFor(input.daysOverdue);
  const factors: PriorityFactor[] = [];

  const add = (
    factorId: PriorityFactorId,
    strength: number,
    source: string,
  ): void => {
    const weight = COLLECTION_PRIORITY_WEIGHTS[factorId];
    const bounded = clamp01(strength);
    factors.push({
      factorId,
      label: PRIORITY_FACTOR_LABELS[factorId],
      weight,
      strength: round2(bounded),
      points: round2(weight * bounded * 100),
      source,
    });
  };

  // ── Exposure at risk ────────────────────────────────────────────────
  // Normalised against a FIXED ceiling, not against the rest of the
  // queue — see EXPOSURE_CEILING for why a relative scale would make
  // today's ranking incomparable with yesterday's.
  const exposureStrength = input.outstanding / EXPOSURE_CEILING;
  add(
    "exposureAtRisk",
    exposureStrength,
    input.outstanding >= EXPOSURE_CEILING
      ? `${fmt(input.outstanding)} outstanding — at or above the ${fmt(EXPOSURE_CEILING)} ceiling`
      : `${fmt(input.outstanding)} outstanding of a ${fmt(EXPOSURE_CEILING)} ceiling`,
  );

  // ── Delinquency depth ───────────────────────────────────────────────
  add(
    "delinquencyDepth",
    DEPTH_BY_BUCKET[agingBucket],
    `${input.daysOverdue} day(s) overdue — band ${agingBucket}`,
  );

  // ── Promise reliability ─────────────────────────────────────────────
  //
  // NOT "probability of payment". This counts what the borrower did when
  // they last committed to a date. Cancelled promises are excluded —
  // they were withdrawn, usually by the officer, and hold no information
  // about the borrower's intent either way.
  const settled = input.promises.filter(
    (p) => p.status === "HONORED" || p.status === "BROKEN",
  );
  const broken = settled.filter((p) => p.status === "BROKEN").length;
  const openPromise = findOpenPromise(input.promises, input.asOf);

  if (settled.length === 0) {
    // Neutral, not zero. No promise history is an absence of evidence,
    // and scoring it as though the borrower had broken one would punish
    // every account nobody has got round to calling yet.
    add(
      "promiseReliability",
      0.5,
      "No settled promise-to-pay on file — neutral",
    );
  } else {
    const brokenRate = broken / settled.length;
    add(
      "promiseReliability",
      brokenRate,
      `${broken} of ${settled.length} promise(s) broken`,
    );
  }

  // ── Contactability ──────────────────────────────────────────────────
  //
  // Two halves: how many ways there are to reach them, and whether
  // anyone has managed to lately. Note the honest limit — CollectionNote
  // records that a contact was ATTEMPTED, with no outcome field, so
  // "last contact" means last attempt logged, not last successful
  // conversation. Scored and named as such.
  const channelCount =
    (input.contact.phone ? 1 : 0) +
    (input.contact.secondaryPhone ? 1 : 0) +
    (input.contact.email ? 1 : 0);
  const reachStrength = channelCount === 0 ? 0 : clamp01(channelCount / 2);
  const daysSinceContact = input.contact.lastContactAt
    ? daysBetween(input.contact.lastContactAt, input.asOf)
    : null;
  // Untouched for a fortnight → full strength; contacted today → none.
  const stalenessStrength =
    daysSinceContact === null ? 1 : clamp01(daysSinceContact / 14);
  add(
    "contactability",
    reachStrength * 0.5 + stalenessStrength * 0.5,
    channelCount === 0
      ? "No phone or email on file — cannot be contacted remotely"
      : `${channelCount} contact channel(s) on file; ${
          daysSinceContact === null
            ? "never contacted"
            : `last contact attempt ${daysSinceContact} day(s) ago`
        }`,
  );

  // ── Repayment history ───────────────────────────────────────────────
  const priorTotal =
    input.history.priorLoansClosed + input.history.priorLoansDefaulted;
  if (priorTotal === 0) {
    add("repaymentHistory", 0.5, "No prior closed loans — neutral");
  } else {
    const badRate = input.history.priorLoansDefaulted / priorTotal;
    add(
      "repaymentHistory",
      badRate,
      `${input.history.priorLoansDefaulted} of ${priorTotal} prior loan(s) defaulted or written off`,
    );
  }

  // ── Risk grade ──────────────────────────────────────────────────────
  if (input.riskGrade === null) {
    add("riskGrade", 0.5, "Never credit-scored — neutral");
  } else {
    add(
      "riskGrade",
      RISK_GRADE_STRENGTH[input.riskGrade],
      `Tier ${input.riskGrade} at last scoring`,
    );
  }

  // ── Collateral coverage ─────────────────────────────────────────────
  if (input.collateralValue === null || input.collateralValue <= 0) {
    add("collateralCoverage", 0, "Unsecured — no collateral on file");
  } else if (input.outstanding <= 0) {
    add("collateralCoverage", 0, "Nothing outstanding to secure");
  } else {
    // Coverage at or above 1.0 scores full: security worth more than the
    // balance is fully recoverable in principle, and how far above adds
    // nothing to the decision to act.
    const coverage = input.collateralValue / input.outstanding;
    add(
      "collateralCoverage",
      coverage,
      `${fmt(input.collateralValue)} appraised against ${fmt(input.outstanding)} outstanding (${Math.round(coverage * 100)}% cover)`,
    );
  }

  // ── Total ───────────────────────────────────────────────────────────
  const rawScore = round2(factors.reduce((sum, f) => sum + f.points, 0));
  const suppressed = SUPPRESSED_STATUSES.has(input.loanStatus);
  // A suppressed account keeps its factor breakdown — the reasoning is
  // still true and still worth reading — but is capped so it cannot
  // outrank a workable one. Balance still orders them among themselves.
  const score = suppressed
    ? round2(
        Math.min(
          SUPPRESSED_SCORE_CEILING,
          (rawScore / 100) * SUPPRESSED_SCORE_CEILING,
        ),
      )
    : rawScore;

  const { action, actionReason } = recommendAction({
    input,
    agingBucket,
    suppressed,
    openPromise,
    hasCollateral: (input.collateralValue ?? 0) > 0,
  });
  const { channel, channelReason } = recommendChannel(action, input.contact);
  const { nextFollowUpDate, followUpReason } = nextFollowUp(
    action,
    input.asOf,
    openPromise,
  );

  return {
    score,
    band: bandFor(score),
    agingBucket,
    factors,
    action,
    actionReason,
    channel,
    channelReason,
    nextFollowUpDate,
    followUpReason,
    suppressed,
    missingFactors: UNSOURCED_FACTORS,
  };
}

/**
 * The most recent promise still awaiting its date, if any.
 *
 * "Open" means status PROMISED and the date has not passed. A PROMISED
 * row whose date HAS passed is a promise nobody resolved — it is not a
 * reason to hold off, and is treated as no open promise at all.
 */
function findOpenPromise(
  promises: readonly PriorityPromiseInput[],
  asOf: Date,
): PriorityPromiseInput | null {
  const open = promises
    .filter((p) => p.status === "PROMISED" && p.promisedDate >= asOf)
    .sort((a, b) => a.promisedDate.getTime() - b.promisedDate.getTime());
  return open[0] ?? null;
}

function bandFor(score: number): PriorityBand {
  if (score >= 65) return "CRITICAL";
  if (score >= 45) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

/**
 * What to do, derived from the same inputs as the score.
 *
 * Ordered by precedence, not by severity: an open promise outranks
 * everything because calling a borrower who committed to pay next
 * Tuesday, on the Monday, is how a keepable promise gets broken.
 */
function recommendAction(args: {
  input: PriorityInput;
  agingBucket: AgingBucket;
  suppressed: boolean;
  openPromise: PriorityPromiseInput | null;
  hasCollateral: boolean;
}): { action: RecommendedAction; actionReason: string } {
  const { input, agingBucket, suppressed, openPromise, hasCollateral } = args;

  if (suppressed) {
    return {
      action: "MONITOR_RECOVERY_ONLY",
      actionReason: `Loan is ${input.loanStatus} — active collection has ended; a payment would still post as a recovery.`,
    };
  }

  if (openPromise) {
    return {
      action: "AWAIT_PROMISE",
      actionReason: `Borrower promised to pay on ${openPromise.promisedDate.toISOString().slice(0, 10)} — do not chase before it falls due.`,
    };
  }

  switch (agingBucket) {
    case "CURRENT":
      return {
        action: "SEND_REMINDER",
        actionReason: "Nothing past due — a courtesy reminder only.",
      };
    case "D_1_30":
      return {
        action: "SEND_REMINDER",
        actionReason: "Early arrears — most cure on a reminder without a call.",
      };
    case "D_31_60":
      return {
        action: "CALL_BORROWER",
        actionReason:
          "Past a full cycle without curing — needs a conversation and a commitment.",
      };
    case "D_61_90":
      return {
        action: "FIELD_VISIT",
        actionReason:
          "Two cycles down and still unresolved by phone — visit before the 90-day line.",
      };
    case "D_91_120":
      return {
        action: "ISSUE_DEMAND_LETTER",
        actionReason:
          "Past 90 days and non-performing — put the demand in writing.",
      };
    case "D_121_180":
      return {
        action: "FINAL_DEMAND",
        actionReason:
          "Written demand has not produced payment — final notice before escalation.",
      };
    case "D_180_PLUS":
      return hasCollateral
        ? {
            action: "INITIATE_REPOSSESSION",
            actionReason:
              "Beyond 180 days with security on file — realise the collateral rather than keep calling.",
          }
        : {
            action: "ESCALATE_LEGAL",
            actionReason:
              "Beyond 180 days and unsecured — collection effort has failed; refer for legal action.",
          };
  }
}

/**
 * How to reach them. Constrained by what is actually on file: an SMS
 * recommendation against a customer with no phone number is worse than
 * no recommendation, because it looks actioned.
 */
function recommendChannel(
  action: RecommendedAction,
  contact: PriorityInput["contact"],
): { channel: RecommendedChannel; channelReason: string } {
  const hasPhone = Boolean(contact.phone ?? contact.secondaryPhone);
  const hasEmail = Boolean(contact.email);

  // Paper actions are paper regardless of what else is on file — a
  // demand letter has to be served to an address to carry any weight.
  if (
    action === "ISSUE_DEMAND_LETTER" ||
    action === "FINAL_DEMAND" ||
    action === "ESCALATE_LEGAL" ||
    action === "INITIATE_REPOSSESSION"
  ) {
    return {
      channel: "LETTER",
      channelReason:
        "Served in writing — required for the escalation to count.",
    };
  }

  if (action === "FIELD_VISIT") {
    return {
      channel: "FIELD",
      channelReason: "In person at the borrower's registered address.",
    };
  }

  if (!hasPhone && !hasEmail) {
    return {
      channel: "FIELD",
      channelReason:
        "No phone or email on file — a visit is the only way to reach this borrower.",
    };
  }

  if (action === "CALL_BORROWER") {
    return hasPhone
      ? { channel: "PHONE", channelReason: "Phone number on file." }
      : {
          channel: "EMAIL",
          channelReason: "No phone on file — email is the only remote channel.",
        };
  }

  // Reminders and recovery monitoring: cheapest channel that works.
  if (hasPhone) {
    return {
      channel: "SMS",
      channelReason: "Cheapest channel that reaches this borrower.",
    };
  }
  return {
    channel: "EMAIL",
    channelReason: "No phone on file — email is the only remote channel.",
  };
}

function nextFollowUp(
  action: RecommendedAction,
  asOf: Date,
  openPromise: PriorityPromiseInput | null,
): { nextFollowUpDate: Date; followUpReason: string } {
  if (action === "AWAIT_PROMISE" && openPromise) {
    // The day AFTER the promise falls due — following up on the day
    // itself chases a borrower who still has until close of business.
    return {
      nextFollowUpDate: addDays(openPromise.promisedDate, 1),
      followUpReason:
        "The day after the promised date — soon enough to catch a broken promise, not so soon as to cause one.",
    };
  }
  const days = FOLLOW_UP_DAYS[action];
  return {
    nextFollowUpDate: addDays(asOf, days),
    followUpReason: `${days} day(s) after this action, the standard interval for ${action}.`,
  };
}

/** Compact money formatting for the explanation strings. */
function fmt(amount: number): string {
  return amount.toLocaleString("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  });
}
