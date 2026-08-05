import type {
  AuditLogRepository,
  CoMakerRepository,
  CreditScoreRepository,
  DecisionRuleRepository,
  KycRepository,
  LoanApplication,
  LoanRepository,
  NotificationRepository,
  PreAssessmentRepository,
  PrismaClient,
  ScreeningRepository,
} from "@loan/db";
import { evaluateRules, type DecisioningContext } from "@loan/decisioning";
import {
  answerDeclarations,
  declarationsComplete,
  snapshotDeclarations,
  validateDeclarations,
  validateKyc,
  type KycAnswers,
  type KycDeclarations,
  type KycDocumentType,
  type KycQuestion,
} from "@loan/kyc";

import { computeAnomalyFlags } from "../../lib/anomaly";
import { evaluateForCustomer } from "../../lib/pre-decision";
import type { ApplyInput, DecideInput } from "./schemas";

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
 * Result of a disburse attempt. CoMakersPending → 409 with the names,
 * so the officer can see who to chase rather than a bare refusal.
 */
export type DisburseResult =
  | { ok: true; loan: LoanApplication }
  | { ok: false; kind: "NotFound" }
  | {
      ok: false;
      kind: "CoMakersPending";
      coMakers: Array<{
        id: string;
        fullName: string;
        status: string;
        declineReason: string | null;
        invited: boolean;
      }>;
    };

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
    }
  | {
      ok: false;
      kind: "DeclarationsIncomplete";
      /** Labels of required declarations still unanswered. */
      unanswered: string[];
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
     * `notifyApproversForStep` needs the FastifyInstance + tenant
     * prisma + tenant-scoped NotificationRepository. The plugin
     * pre-binds all three so the service stays Fastify-agnostic — it
     * just calls `notifyApprovers(loanId, step)`.
     */
    private readonly notifyApprovers: (
      loanId: string,
      stepOrder: number,
    ) => Promise<void>,
    /**
     * Only used to link an application back to the pre-assessment it came
     * out of. Optional so the many call sites that never see a
     * pre-assessment don't have to construct one.
     */
    private readonly preAssessments?: PreAssessmentRepository,
    /**
     * Consent gate on disburse. Optional for the same reason as
     * `preAssessments` — plenty of call sites construct this service
     * without ever reaching disburse, and a loan with no co-makers
     * passes the gate trivially.
     */
    private readonly coMakers?: CoMakerRepository,
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

    /*
     * KYC declarations. Answers may be PARTIAL — completeness gates
     * approval, not submission, so the questionnaire can also be
     * finished later at the KYC stage — but any answer present must fit
     * its question (a NUMBER answering "abc" is tampering or a bug, not
     * an unfinished form). The questions + answers are snapshotted as
     * they stood: the admin can rewrite the questionnaire tomorrow
     * without rewriting what this applicant attested to.
     */
    const product = await this.prisma.loanProduct.findUnique({
      where: { code: input.productCode },
    });
    const questions = (product?.kycQuestions ?? []) as unknown as KycQuestion[];
    let kycDeclarations: KycDeclarations | undefined;
    if (questions.length > 0) {
      const answers = input.kycAnswers ?? {};
      const check = validateDeclarations(questions, answers);
      if (check.invalid.length > 0) {
        return {
          ok: false,
          kind: "BadRequest",
          message: "One or more declaration answers are malformed.",
          issues: check.invalid,
        };
      }
      kycDeclarations = snapshotDeclarations(questions, answers, {
        id: actorId,
      });
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
        kycDeclarations,
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

    // Link the pre-assessment this came out of, if the caller named one.
    // Best-effort on purpose: the loan is already committed, and a stale
    // or already-converted id is not a reason to fail an application the
    // borrower has just submitted. `loanId` is unique, so a second
    // assessment claiming the same loan lands here and is swallowed.
    if (input.preAssessmentId && this.preAssessments) {
      try {
        await this.preAssessments.markConverted(
          input.preAssessmentId,
          created.id,
        );
      } catch (err) {
        this.log.warn(
          { err, preAssessmentId: input.preAssessmentId, loanId: created.id },
          "could not link pre-assessment to loan",
        );
      }
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

      /*
       * Declarations gate — against the SNAPSHOT taken at apply, not
       * the product's current questionnaire: the contract is "answer
       * what you were asked", and an admin adding a required question
       * tomorrow must not retroactively block yesterday's application.
       * The same override flag covers it: "approve despite incomplete
       * KYC" means the whole KYC posture, documents and declarations.
       */
      const decl = declarationsComplete(
        loan.kycDeclarations as KycDeclarations | null,
      );
      if (!decl.complete) {
        if (!input.overrideKyc) {
          return {
            ok: false,
            kind: "DeclarationsIncomplete",
            unanswered: decl.missing.map((m) => m.label),
            loanProductCode: loan.productCode,
          };
        }
        const note = `[Declarations override: ${decl.missing.length} required unanswered]`;
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
   * Answer (or amend) an application's KYC declarations — the KYC-stage
   * capture. Merges into the snapshot taken at apply, validating each
   * answer against the question AS ASKED (types, and SELECT options as
   * offered then). Only pre-decision applications can be edited: the
   * declarations are part of what approval judged, and rewriting them
   * under a decided loan would falsify the record it was decided on.
   *
   * When the loan predates the questionnaire (no snapshot) and the
   * product HAS one now, a snapshot is created from the current
   * questions — that's the officer back-filling declarations for an
   * in-flight application after the admin added the questionnaire.
   */
  async answerDeclarations(
    idOrNumber: string,
    answers: KycAnswers,
    actorId: string,
  ): Promise<
    | { ok: true; declarations: KycDeclarations }
    | { ok: false; kind: "NotFound" }
    | { ok: false; kind: "NotEditable"; status: string }
    | { ok: false; kind: "NoQuestionnaire" }
    | {
        ok: false;
        kind: "InvalidAnswers";
        invalid: Array<{ id: string; reason: string }>;
      }
  > {
    const loan = await this.loans.findByIdOrNumber(idOrNumber);
    if (!loan) return { ok: false, kind: "NotFound" };
    if (!["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(loan.status)) {
      return { ok: false, kind: "NotEditable", status: loan.status };
    }

    const current = loan.kycDeclarations as KycDeclarations | null;
    let result: KycDeclarations;
    if (current && current.items.length > 0) {
      const merged = answerDeclarations(current, answers, { id: actorId });
      if (!merged.ok) {
        return { ok: false, kind: "InvalidAnswers", invalid: merged.invalid };
      }
      result = merged.next;
    } else {
      const questions = (loan.product?.kycQuestions ??
        []) as unknown as KycQuestion[];
      if (questions.length === 0) return { ok: false, kind: "NoQuestionnaire" };
      const check = validateDeclarations(questions, answers);
      if (check.invalid.length > 0) {
        return { ok: false, kind: "InvalidAnswers", invalid: check.invalid };
      }
      result = snapshotDeclarations(questions, answers, { id: actorId });
    }

    await this.prisma.loanApplication.update({
      where: { id: loan.id },
      data: { kycDeclarations: result as never },
    });
    return { ok: true, declarations: result };
  }

  /**
   * Disburse an APPROVED loan. The repo posts the journal entry +
   * schedule rows; we fan-out a "your loan disbursed" notification
   * if the borrower has an email on file. The notification is
   * best-effort: a failed dispatch must not undo the disburse.
   */
  async disburse(idOrNumber: string, actorId: string): Promise<DisburseResult> {
    // Co-makers are jointly liable, so releasing funds before they've
    // agreed hands someone a debt they never accepted. Checked here
    // rather than in the repository because the answer is a 409 with
    // names in it, not an exception.
    const target = await this.loans.findByIdOrNumber(idOrNumber);
    if (!target) return { ok: false, kind: "NotFound" };
    const outstanding =
      (await this.coMakers?.notApprovedForLoan(target.id)) ?? [];
    if (outstanding.length > 0) {
      return {
        ok: false,
        kind: "CoMakersPending",
        coMakers: outstanding.map((c) => ({
          id: c.id,
          fullName: c.fullName,
          status: c.status,
          declineReason: c.declineReason,
          invited: c.inviteSentAt !== null,
        })),
      };
    }

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

    return { ok: true, loan: disbursed };
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
    // Shared with the pre-assessment feature — see lib/pre-decision.ts for
    // why there is exactly one context builder. The lookups inside run in
    // parallel; this endpoint is hit on every form-edit debounce.
    const outcome = await evaluateForCustomer(
      {
        prisma: this.prisma,
        screening: this.screening,
        scores: this.scores,
        kyc: this.kyc,
        rules: this.rules,
      },
      input.customerId,
      {
        productCode: input.productCode,
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: input.annualInterestRate,
      },
    );

    if (!outcome) return { ok: false, kind: "CustomerNotFound" };

    return {
      ok: true,
      result: {
        verdict: outcome.verdict,
        reason: outcome.reason,
        matchedRule: outcome.matchedRule,
        // Non-null for the customer path by construction.
        gates: outcome.gates!,
        anomalies: outcome.anomalies,
        // Renamed fields preserve the existing wire contract that the
        // new-loan dialog consumes; see DryRunContext.
        context: {
          principal: outcome.context.principal,
          termMonths: outcome.context.termMonths,
          annualInterestRate: outcome.context.annualInterestRate,
          productCode: outcome.context.productCode,
          creditScore: outcome.context.creditScoreAtApply,
          tier: outcome.context.tierAtApply,
          monthlyIncome: outcome.context.monthlyIncome,
          existingActiveLoans: outcome.context.existingActiveLoans,
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
