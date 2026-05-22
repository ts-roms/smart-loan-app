import type {
  AuditLogRepository,
  CreditScoreRepository,
  DecisionRuleRepository,
  KycRepository,
  LoanApplication,
  LoanRepository,
  NotificationRepository,
  PrismaClient,
  ScreeningRepository,
} from "@loan/db";
import { evaluateRules, type DecisioningContext } from "@loan/decisioning";
import { validateKyc, type KycDocumentType } from "@loan/kyc";

import { computeAnomalyFlags } from "../../lib/anomaly.js";
import { notifyApproversForStep } from "./notify-approvers.js";
import type { ApplyInput, DecideInput } from "./schemas.js";

/**
 * Loan-workflow service — owns the application/decision/disburse triad.
 *
 * The other ~25 endpoints in `loans.routes.ts` are thin enough that they
 * call repositories directly from the route file (per the "earn its
 * keep" rule in docs/architecture.md). This service holds only the
 * paths whose orchestration actually warrants the layer:
 *
 *   • apply()     — AML gate + KYC validation + decisioning + anomaly
 *                   flagging + audit + approval-chain notification.
 *   • decide()    — KYC gate (with admin override) + repo decide.
 *   • disburse()  — repo disburse + best-effort borrower notification.
 *   • dryRun()    — pure preview of the same evaluation, no persistence.
 *
 * Dependencies are passed via constructor — the Fastify plugin in
 * `index.ts` is the composition root. No Fastify imports here; the
 * controller maps service results to HTTP codes.
 */

/** Minimal logger shape — Fastify's logger satisfies it structurally. */
export interface ServiceLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Result of an apply attempt. Discriminated union so the controller
 * can map AmlBlocked → 409 and BadRequest → 400 without an exception.
 */
export type ApplyResult =
  | {
      ok: true;
      loan: LoanApplication & {
        decision: ReturnType<typeof evaluateRules>;
      };
    }
  | {
      ok: false;
      kind: "AmlBlocked";
      message: string;
      screeningId: string;
    }
  | { ok: false; kind: "BadRequest"; message: string; issues?: unknown };

/**
 * Result of a decide attempt. NotFound → 404, KycIncomplete → 409
 * (unless overridden by an admin), Ok → 200.
 */
export type DecideResult =
  | { ok: true; loan: LoanApplication }
  | { ok: false; kind: "NotFound" }
  | {
      ok: false;
      kind: "KycIncomplete";
      missing: KycDocumentType[];
      rejected: KycDocumentType[];
      status: string;
      loanProductCode: string;
    };

/**
 * UI-flavoured context shape used by the dry-run response. Renames a
 * couple of DecisioningContext fields (`creditScoreAtApply` →
 * `creditScore`, `tierAtApply` → `tier`) to match the wire contract
 * the new-loan dialog has been consuming.
 */
export interface DryRunContext {
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  productCode: string;
  creditScore: number | null;
  tier: string | null;
  monthlyIncome: number;
  existingActiveLoans: number;
}

export type DryRunResult =
  | {
      ok: true;
      result: {
        verdict: "APPROVE" | "REVIEW" | "REJECT";
        reason: string | null;
        matchedRule: { id: string; name: string } | null;
        gates: {
          amlMatch: boolean;
          kycComplete: boolean;
          missingKycDocs: KycDocumentType[];
          rejectedKycDocs: KycDocumentType[];
        };
        anomalies: Awaited<ReturnType<typeof computeAnomalyFlags>>;
        context: DryRunContext;
      };
    }
  | { ok: false; kind: "CustomerNotFound" };

export class LoanWorkflowService {
  constructor(
    private readonly loans: LoanRepository,
    private readonly scores: CreditScoreRepository,
    private readonly kyc: KycRepository,
    private readonly rules: DecisionRuleRepository,
    private readonly audit: AuditLogRepository,
    private readonly prisma: PrismaClient,
    private readonly screening: ScreeningRepository,
    private readonly notifications: NotificationRepository,
    private readonly log: ServiceLogger,
    /**
     * `notifyApproversForStep` requires the FastifyInstance to pull
     * `app.notifications`, `app.prisma`, and `app.log`. Rather than
     * leak Fastify into the service, the plugin passes a pre-bound
     * function — the equivalent of `(loanId, step) => notifyApproversForStep(app, loanId, step)`.
     */
    private readonly notifyApprovers: (
      loanId: string,
      stepOrder: number,
    ) => Promise<void>,
  ) {}

  /**
   * Submit a new loan application. Orchestrates the full flow:
   *   1. AML gate (403/409 if MATCH on file without override).
   *   2. Build the decisioning context (score, KYC, customer demographics,
   *      AML status, active-loan count).
   *   3. Evaluate decision rules → AUTO_APPROVE / AUTO_REJECT / SUBMITTED.
   *   4. Persist the loan with the chosen initial status.
   *   5. Audit the rule match (if any).
   *   6. Anomaly flagger (best-effort, never blocks).
   *   7. Fan-out approval notifications if a chain is configured.
   *
   * Returns a discriminated union so the controller can map each
   * outcome to its specific HTTP code without throwing for control flow.
   */
  async apply(input: ApplyInput, actorId: string): Promise<ApplyResult> {
    // AML gate. ADMIN can override via /screening/customers/:id/override,
    // which posts an OVERRIDDEN row that supersedes the MATCH.
    const latestScreen = await this.screening.latestForCustomer(
      input.customerId,
    );
    if (latestScreen?.status === "MATCH") {
      return {
        ok: false,
        kind: "AmlBlocked",
        message: "Customer has an unresolved AML match. Override required.",
        screeningId: latestScreen.id,
      };
    }

    const ctx = await this.buildDecisioningContext(
      input,
      latestScreen?.status ?? null,
    );
    const ruleRows = await this.rules.listActive();
    const decision = evaluateRules(this.rules.toEvaluable(ruleRows), ctx);
    const initialStatus: "SUBMITTED" | "APPROVED" | "REJECTED" =
      decision.action === "AUTO_APPROVE"
        ? "APPROVED"
        : decision.action === "AUTO_REJECT"
          ? "REJECTED"
          : "SUBMITTED";

    let created: LoanApplication;
    try {
      created = await this.loans.apply({
        ...input,
        submittedById: actorId,
        creditScoreAtApply: ctx.creditScoreAtApply ?? null,
        tierAtApply: ctx.tierAtApply ?? null,
        initialStatus,
        initialDecisionReason:
          initialStatus === "SUBMITTED" ? undefined : decision.reason,
      });
    } catch (err) {
      const e = err as Error & { issues?: unknown };
      return {
        ok: false,
        kind: "BadRequest",
        message: e.message,
        issues: e.issues,
      };
    }

    if (decision.matched) {
      await this.audit.record({
        action: `LOAN_AUTO_${decision.action}`,
        actorId,
        targetType: "LoanApplication",
        targetId: created.id,
        payload: {
          rule: decision.matched.name,
          reason: decision.reason,
          context: ctx,
        },
      });
    }

    // Anomaly flagger — best-effort, never blocks. We only audit the
    // medium/high signals; low-severity flags (e.g. INSUFFICIENT_BASELINE)
    // are noise in the log.
    try {
      const anomalies = await computeAnomalyFlags(this.prisma, {
        customerId: input.customerId,
        productCode: input.productCode,
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: input.annualInterestRate,
        monthlyIncome: ctx.monthlyIncome,
      });
      const actionable = anomalies.filter(
        (a) => a.severity === "medium" || a.severity === "high",
      );
      if (actionable.length > 0) {
        await this.audit.record({
          action: "LOAN_APPLICATION_FLAGGED",
          actorId,
          targetType: "LoanApplication",
          targetId: created.id,
          payload: { anomalies: actionable },
        });
      }
    } catch (err) {
      this.log.warn(
        { err, loanId: created.id },
        "anomaly flagger failed; loan apply continued",
      );
    }

    // Fan out to step-1 approvers if the product has a chain configured.
    if (created.currentApprovalStep) {
      void this.notifyApprovers(created.id, created.currentApprovalStep);
    }

    return { ok: true, loan: { ...created, decision } };
  }

  /**
   * Officer decision on a SUBMITTED loan. When approving, we re-run
   * KYC validation (which may have changed since apply) and block on
   * incomplete docs unless the caller passed `overrideKyc: true` — the
   * override is itself audited via the appended reason note.
   */
  async decide(
    idOrNumber: string,
    input: DecideInput,
    actorId: string,
  ): Promise<DecideResult> {
    let reason = input.reason;

    if (input.status === "APPROVED") {
      const loan = await this.loans.findByIdOrNumber(idOrNumber);
      if (!loan) return { ok: false, kind: "NotFound" };
      const docs = await this.kyc.listForCustomer(loan.customerId);
      const extras = (loan.product?.requiredKycDocs ?? []) as KycDocumentType[];
      const kycResult = validateKyc(docs, extras);
      if (!kycResult.complete) {
        if (!input.overrideKyc) {
          return {
            ok: false,
            kind: "KycIncomplete",
            missing: kycResult.missing,
            rejected: kycResult.rejected,
            status: kycResult.status,
            loanProductCode: loan.productCode,
          };
        }
        const note = `[KYC override: missing=${
          kycResult.missing.join(",") || "none"
        }, rejected=${kycResult.rejected.join(",") || "none"}]`;
        reason = reason ? `${reason} ${note}` : note;
      }
    }

    const updated = await this.loans.decide(idOrNumber, {
      status: input.status,
      reason,
      decidedById: actorId,
    });
    return { ok: true, loan: updated };
  }

  /**
   * Disburse an APPROVED loan. The repo posts the journal entry +
   * schedule rows; we fan-out a "your loan disbursed" notification
   * if the borrower has an email on file. The notification is
   * best-effort: a failed dispatch must not undo the disburse.
   */
  async disburse(
    idOrNumber: string,
    actorId: string,
  ): Promise<LoanApplication> {
    const disbursed = await this.loans.disburse(idOrNumber, {
      disbursedById: actorId,
    });

    try {
      const loan = await this.loans.findById(disbursed.id);
      const c = loan?.customer;
      const firstSchedule = loan?.schedule?.[0];
      if (loan && c && c.email) {
        await this.notifications.dispatch({
          event: "LOAN_DISBURSED",
          channel: "EMAIL",
          recipient: c.email,
          data: {
            customerName: `${c.firstName} ${c.lastName}`,
            loanNumber: loan.number,
            amount: Number(loan.principal),
            dueDate: firstSchedule
              ? new Date(firstSchedule.dueDate).toISOString().slice(0, 10)
              : "",
          },
          refType: "LoanApplication",
          refId: loan.id,
          customerId: c.id,
        });
      }
    } catch {
      // Non-fatal — the disburse already committed.
    }

    return disbursed;
  }

  /**
   * Pre-decisioning preview. Mirrors the rule-evaluation slice of
   * apply() but does NOT create a loan or write audit rows — pure
   * read-only. Used by the new-loan dialog so the officer sees the
   * verdict + reasons (and the precise rule that fired) before
   * pressing Submit. Returns gates that aren't decisioning rules
   * (active AML match, KYC incomplete) as a distinct field so the UI
   * can render them as pre-flight checks.
   */
  async dryRun(input: ApplyInput): Promise<DryRunResult> {
    // Run all the lookups in parallel — this endpoint is hit on every
    // form-edit debounce, so latency matters.
    const [latestScreen, score, customer, docs, product, activeLoans] =
      await Promise.all([
        this.screening.latestForCustomer(input.customerId),
        this.scores.latestForCustomer(input.customerId),
        this.prisma.customer.findUnique({ where: { id: input.customerId } }),
        this.kyc.listForCustomer(input.customerId),
        this.prisma.loanProduct.findUnique({
          where: { code: input.productCode },
        }),
        this.prisma.loanApplication.count({
          where: {
            customerId: input.customerId,
            status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
          },
        }),
      ]);

    if (!customer) return { ok: false, kind: "CustomerNotFound" };

    const extras = (product?.requiredKycDocs ?? []) as KycDocumentType[];
    const kycRes = validateKyc(docs, extras);
    const customerAge = Math.floor(
      (Date.now() - customer.dateOfBirth.getTime()) / (365.25 * 86_400_000),
    );

    const context: DecisioningContext = {
      productCode: input.productCode,
      principal: input.principal,
      termMonths: input.termMonths,
      annualInterestRate: input.annualInterestRate,
      tierAtApply: score?.tier ?? null,
      creditScoreAtApply: score?.score ?? null,
      amlStatus: latestScreen?.status ?? null,
      kycComplete: kycRes.complete,
      customerAge,
      monthlyIncome: Number(customer.monthlyIncome),
      existingActiveLoans: activeLoans,
    };

    const ruleRows = await this.rules.listActive();
    const decision = evaluateRules(this.rules.toEvaluable(ruleRows), context);

    const verdict: "APPROVE" | "REVIEW" | "REJECT" =
      decision.action === "AUTO_APPROVE"
        ? "APPROVE"
        : decision.action === "AUTO_REJECT"
          ? "REJECT"
          : "REVIEW";

    const anomalies = await computeAnomalyFlags(this.prisma, {
      customerId: input.customerId,
      productCode: input.productCode,
      principal: input.principal,
      termMonths: input.termMonths,
      annualInterestRate: input.annualInterestRate,
      monthlyIncome: Number(customer.monthlyIncome),
    });

    return {
      ok: true,
      result: {
        verdict,
        reason: decision.reason,
        matchedRule: decision.matched
          ? { id: decision.matched.id, name: decision.matched.name }
          : null,
        gates: {
          amlMatch: latestScreen?.status === "MATCH",
          kycComplete: kycRes.complete,
          missingKycDocs: kycRes.missing,
          rejectedKycDocs: kycRes.rejected,
        },
        anomalies,
        // Renamed fields preserve the existing wire contract that the
        // new-loan dialog consumes; see DryRunContext.
        context: {
          principal: input.principal,
          termMonths: input.termMonths,
          annualInterestRate: input.annualInterestRate,
          productCode: input.productCode,
          creditScore: context.creditScoreAtApply,
          tier: context.tierAtApply,
          monthlyIncome: context.monthlyIncome,
          existingActiveLoans: context.existingActiveLoans,
        },
      },
    };
  }

  /**
   * Private helper for `apply` — builds the decisioning context from
   * the customer + product + KYC + active-loans state. Pulled out so
   * `apply` reads as a flat sequence of steps and dryRun() doesn't
   * have to duplicate it (well, it would — but with parallel lookups,
   * see above).
   */
  private async buildDecisioningContext(
    input: ApplyInput,
    amlStatus: string | null,
  ): Promise<DecisioningContext> {
    const [score, customer, docs, product, activeLoans] = await Promise.all([
      this.scores.latestForCustomer(input.customerId),
      this.prisma.customer.findUnique({ where: { id: input.customerId } }),
      this.kyc.listForCustomer(input.customerId),
      this.prisma.loanProduct.findUnique({
        where: { code: input.productCode },
      }),
      this.prisma.loanApplication.count({
        where: {
          customerId: input.customerId,
          status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
        },
      }),
    ]);

    const extras = (product?.requiredKycDocs ?? []) as KycDocumentType[];
    const kycRes = validateKyc(docs, extras);
    const customerAge = customer
      ? Math.floor(
          (Date.now() - customer.dateOfBirth.getTime()) / (365.25 * 86_400_000),
        )
      : 0;

    return {
      productCode: input.productCode,
      principal: input.principal,
      termMonths: input.termMonths,
      annualInterestRate: input.annualInterestRate,
      tierAtApply: score?.tier ?? null,
      creditScoreAtApply: score?.score ?? null,
      amlStatus: amlStatus as DecisioningContext["amlStatus"],
      kycComplete: kycRes.complete,
      customerAge,
      monthlyIncome: customer ? Number(customer.monthlyIncome) : 0,
      existingActiveLoans: activeLoans,
    };
  }
}
