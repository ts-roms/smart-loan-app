import { CustomerHasLiveLoanError } from "@loan/db";
import type {
  AuditLogRepository,
  CoMakerRepository,
  CreditScoreRepository,
  CustomerExposureRepository,
  DecisionRuleRepository,
  KycRepository,
  LoanApplication,
  LoanApprovalRepository,
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
import {
  buildExposureContext,
  evaluateForCustomer,
  newLoanInstallment,
} from "../../lib/pre-decision";
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
  | { ok: false; kind: "BadRequest"; message: string; issues?: unknown }
  | { ok: false; kind: "CustomerErased"; message: string }
  | { ok: false; kind: "CustomerArchived"; message: string }
  | {
      ok: false;
      kind: "HasLiveLoan";
      message: string;
      /** The loans already open, so the officer sees which. */
      liveLoans: Array<{
        id: string;
        number: string;
        status: string;
        principal: number;
      }>;
    };

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
    }
  | {
      ok: false;
      kind: "ApprovalChainPending";
      /** Steps still awaiting sign-off, in order. */
      pending: Array<{ stepOrder: number; stepLabel: string }>;
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
    /**
     * Consolidated exposure (§53) — a decisioning input, not a report.
     * Required rather than optional: a service constructed without it
     * would underwrite every application as though the borrower held no
     * other loans, silently, which is the exact defect this closes.
     */
    private readonly exposure: CustomerExposureRepository,
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
    /**
     * The approval chain, for the gate in `decide`.
     *
     * Optional to match the two above, and its absence is handled the
     * same way an empty chain is — as "nothing pending". That is the
     * correct default: a product with no chain configured has always
     * been approvable in one step, and a caller that didn't wire this up
     * must not silently start blocking every decision.
     */
    private readonly approvals?: LoanApprovalRepository,
  ) {}

  /**
   * Submit a new loan application. Orchestrates the full flow:
   *   1. AML gate (403/409 if MATCH on file without override).
   *   2. Build the decisioning context (score, KYC, customer demographics,
   *      AML status, active-loan count).
   *   3. Evaluate decision rules → REJECTED, or SUBMITTED. A favourable
   *      rule (AUTO_APPROVE) is a recommendation carried in the decision
   *      reason, not an outcome — see the note at the call site.
   *   4. Persist the loan with the chosen initial status.
   *   5. Audit the rule match (if any).
   *   6. Anomaly flagger (best-effort, never blocks).
   *   7. Fan-out approval notifications if a chain is configured.
   *
   * Returns a discriminated union so the controller can map each
   * outcome to its specific HTTP code without throwing for control flow.
   */
  async apply(input: ApplyInput, actorId: string): Promise<ApplyResult> {
    // A privacy-erased customer cannot take a new loan: underwriting
    // needs an identity, and the record no longer has one. The UI hides
    // the apply button, but the endpoint is the actual guarantee.
    const applicant = await this.prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { erasedAt: true, archivedAt: true },
    });
    if (applicant?.erasedAt) {
      return {
        ok: false,
        kind: "CustomerErased",
        message:
          "This customer's personal data was erased under a data privacy request; new loan applications are not possible.",
      };
    }
    // Archived means taken off the books. Restoring them is one click
    // and is the deliberate decision this refusal asks for.
    if (applicant?.archivedAt) {
      return {
        ok: false,
        kind: "CustomerArchived",
        message:
          "This customer is archived. Restore them before starting a new application.",
      };
    }

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
     * One live loan at a time.
     *
     * Nothing stopped a customer holding two, three, five concurrent
     * applications: `existingActiveLoans` fed the decision rules as a
     * number to reason about, but no rule was obliged to look at it and
     * none of the seeded ones refused on it. So a double-submitted form
     * became two real loans, and a borrower could quietly stack debt the
     * capacity check had never seen together.
     *
     * "Live" spans both money out (DISBURSED / ACTIVE / DEFAULTED) and
     * money promised (SUBMITTED / UNDER_REVIEW / APPROVED). An in-flight
     * application counts because two open applications from one customer
     * is nearly always a double-submit, and because approving the second
     * would commit funds the first already claimed.
     *
     * Terminal states — CLOSED, REJECTED, CANCELLED, WRITTEN_OFF — do
     * not block. A settled borrower is free to come back, which is the
     * ordinary case this must not obstruct.
     */
    const liveLoans = await this.prisma.loanApplication.findMany({
      where: {
        customerId: input.customerId,
        status: {
          in: [
            "SUBMITTED",
            "UNDER_REVIEW",
            "APPROVED",
            "DISBURSED",
            "ACTIVE",
            "DEFAULTED",
          ],
        },
      },
      select: { id: true, number: true, status: true, principal: true },
      orderBy: { submittedAt: "desc" },
    });
    if (liveLoans.length > 0) {
      const first = liveLoans[0]!;
      return {
        ok: false,
        kind: "HasLiveLoan",
        message:
          liveLoans.length === 1
            ? `This customer already has loan ${first.number} (${first.status}). Settle or close it before applying again.`
            : `This customer already has ${liveLoans.length} open loans (${liveLoans.map((l) => l.number).join(", ")}). Settle or close them before applying again.`,
        liveLoans: liveLoans.map((l) => ({
          id: l.id,
          number: l.number,
          status: l.status,
          principal: Number(l.principal),
        })),
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
    /*
     * AUTO_APPROVE is a RECOMMENDATION, not an outcome.
     *
     * It used to land the loan on APPROVED at submission, which meant a
     * fast-tracked application was decided before any human saw it —
     * and, because the chain is only stamped onto SUBMITTED loans, it
     * skipped every sign-off by construction. The two seeded rules that
     * do this (A-tier and B-tier fast-track) between them cover the
     * healthiest applications, i.e. exactly the ones a lender is most
     * often asked to justify afterwards.
     *
     * So a favourable rule now routes into the chain like everything
     * else. The engine's finding isn't lost — it rides along as the
     * decision reason, so the first approver opens the file already
     * knowing scoring is in favour. What changes is who gets to say
     * yes.
     *
     * AUTO_REJECT stays final. Declining is not the risk this guards
     * against, and the rules that reject — AML hard-block, F tier — are
     * compliance controls that SHOULD fire without waiting for a queue.
     * A rejected applicant can be reconsidered by hand; an
     * auto-approved one is already money out the door.
     */
    const autoApproved = decision.action === "AUTO_APPROVE";
    const initialStatus: "SUBMITTED" | "APPROVED" | "REJECTED" =
      decision.action === "AUTO_REJECT" ? "REJECTED" : "SUBMITTED";

    let created: LoanApplication;
    try {
      created = await this.loans.apply({
        ...input,
        submittedById: actorId,
        creditScoreAtApply: ctx.creditScoreAtApply ?? null,
        tierAtApply: ctx.tierAtApply ?? null,
        kycDeclarations,
        initialStatus,
        /*
         * Carried for a fast-tracked loan too, marked as what it is.
         * Without the prefix the first approver would open a SUBMITTED
         * file whose reason reads like a decision already taken.
         */
        initialDecisionReason: autoApproved
          ? `[Scoring recommends approval] ${decision.reason}`
          : initialStatus === "SUBMITTED"
            ? undefined
            : decision.reason,
        /*
         * Which rule version decided this, and on what figures.
         *
         * Stamped on every path, not just the decided ones. A loan routed
         * to manual review was still evaluated, and "the rules in force
         * that day had nothing to say about this application" is a
         * different — and materially better — record than silence, which
         * is indistinguishable from the engine never having run.
         */
        decisionRule: decision.matched
          ? {
              id: decision.matched.id,
              name: decision.matched.name,
              version: decision.matched.version,
            }
          : null,
        decisionContext: ctx,
      });
    } catch (err) {
      /*
       * The repository enforces one-live-loan inside its transaction —
       * see CustomerHasLiveLoanError. The pre-check above catches the
       * ordinary case with a richer payload; this catches the race,
       * where two submissions both passed that check before either
       * inserted.
       */
      if (err instanceof CustomerHasLiveLoanError) {
        return {
          ok: false,
          kind: "HasLiveLoan",
          message: err.message,
          liveLoans: err.liveLoans,
        };
      }
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

      /*
       * The approval chain, enforced.
       *
       * This endpoint used to set APPROVED directly after the KYC and
       * declarations checks, without ever looking at LoanApproval. The
       * whole chain — per-step permissions, delegation, the frozen
       * labels, the notifications to each step's approvers — was
       * therefore advisory: one officer holding `loans.decide` could
       * approve past every outstanding sign-off in a single call, and
       * nothing recorded that the steps had been skipped.
       *
       * Rejection is deliberately NOT gated. A loan can be turned down
       * at any point in the chain; requiring three sign-offs before
       * someone may say no would keep bad applications alive for no
       * reason.
       *
       * An empty chain means nothing pending, which is how products
       * with no configured steps keep working exactly as before.
       */
      const pending = (await this.approvals?.pendingSteps(loan.id)) ?? [];
      if (pending.length > 0) {
        return {
          ok: false,
          kind: "ApprovalChainPending",
          pending: pending.map((s) => ({
            stepOrder: s.stepOrder,
            stepLabel: s.stepLabel,
          })),
        };
      }

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
      /*
       * §56 — handed down so the audit row lands inside the repository's
       * disbursement transaction, not after it. Recording here instead
       * (after the await) would leave a window where the money has moved
       * and nothing says who moved it.
       */
      audit: this.audit,
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
          refNumber: loan.number,
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
        exposure: this.exposure,
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
    const [score, customer, docs, product, activeLoans, exposure] =
      await Promise.all([
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
        /*
         * §53: what the lender is already into this borrower for.
         *
         * Fetched here, once, alongside every other input — not looked
         * up again downstream. The whole point of a consolidated figure
         * is that there is one of it, and a decision that read exposure
         * twice could stamp one number onto the record and act on
         * another if a payment landed between the two reads.
         */
        this.exposure.forDecision(input.customerId),
      ]);

    const extras = (product?.requiredKycDocs ?? []) as KycDocumentType[];
    const kycRes = validateKyc(docs, extras);
    const customerAge = customer
      ? Math.floor(
          (Date.now() - customer.dateOfBirth.getTime()) / (365.25 * 86_400_000),
        )
      : 0;
    const monthlyIncome = customer ? Number(customer.monthlyIncome) : 0;
    const terms = {
      productCode: input.productCode,
      principal: input.principal,
      termMonths: input.termMonths,
      annualInterestRate: input.annualInterestRate,
    };

    return {
      ...terms,
      tierAtApply: score?.tier ?? null,
      creditScoreAtApply: score?.score ?? null,
      amlStatus: amlStatus as DecisioningContext["amlStatus"],
      kycComplete: kycRes.complete,
      customerAge,
      monthlyIncome,
      existingActiveLoans: activeLoans,
      /*
       * The same fold the dry-run preview and the pre-assessment run —
       * see lib/pre-decision.ts. Sharing it is what stops an officer
       * being shown one affordability picture in the wizard and the
       * engine deciding on another when they press Submit.
       *
       * These figures land verbatim in `decisionContext` at the call
       * site in apply(), which is what §20 asks for: the inputs as the
       * engine saw them, beside the rule version that read them.
       */
      ...buildExposureContext({
        snapshot: exposure,
        monthlyIncome,
        principal: input.principal,
        newLoanInstallment: newLoanInstallment(terms, product),
      }),
    };
  }
}
