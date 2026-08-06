import { phoneChangeError } from "@loan/shared-utils";
import {
  CustomerHasLiveLoanError,
  type CooperativeRepository,
  type CreditScoreRepository,
  type CustomerLedgerRepository,
  type KycRepository,
  type LoanRepository,
  type PaymentIntentRepository,
  type PrismaClient,
} from "@loan/db";
import {
  answerDeclarations,
  snapshotDeclarations,
  validateDeclarations,
  validateKyc,
  type KycAnswers,
  type KycDeclarations,
  type KycQuestion,
} from "@loan/kyc";
import { renderCustomerStatement } from "@loan/pdf";
import { randomUUID } from "node:crypto";

import { getBranding } from "../../lib/branding";

import type {
  PortalPreAssessmentInput,
  PreAssessmentService,
} from "../pre-assessment/index";

import type { LedgerScope } from "./helpers";
import type {
  ApplyInput,
  IntentInput,
  KycSubmitInput,
  ProfileUpdateInput,
} from "./schemas";

/**
 * Borrower-portal orchestration. The portal is implicitly scoped to
 * the authenticated CUSTOMER user — every read/write here resolves
 * `customerId` from the JWT subject and then refuses to touch any row
 * that doesn't belong to that customer.
 *
 * The service exposes that scoping as an explicit step:
 *
 *   const auth = await service.resolveCustomerId(req.user.sub);
 *   if (!auth.ok) return reply.code(403).send({ ... });
 *   const result = await service.getLoan(auth.customerId, ...);
 *
 * Every subsequent call takes `customerId` as the first arg so
 * ownership is part of the type signature, not a runtime convention.
 */

export type ResolveResult =
  | { ok: true; customerId: string }
  | { ok: false; kind: "NotLinked"; message: string };

export type LookupResult<T> =
  { ok: true; value: T } | { ok: false; kind: "NotFound" };

export type ApplyResult =
  | { ok: true; loan: Awaited<ReturnType<LoanRepository["apply"]>> }
  | { ok: false; kind: "RepoError"; message: string; issues?: unknown }
  | {
      ok: false;
      kind: "HasLiveLoan";
      message: string;
      liveLoans: Array<{ id: string; number: string; status: string }>;
    };

export interface LedgerOpts {
  from?: Date;
  to?: Date;
  scope: LedgerScope;
}

export class PortalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly loans: LoanRepository,
    private readonly scores: CreditScoreRepository,
    private readonly kyc: KycRepository,
    private readonly coop: CooperativeRepository,
    private readonly ledger: CustomerLedgerRepository,
    private readonly intents: PaymentIntentRepository,
    private readonly intentWebhookUrl: string,
    /**
     * Shared with the staff-facing /pre-assessments feature. Reused rather
     * than reimplemented so a borrower's self-check and an officer's check
     * of the same borrower can't return different verdicts.
     */
    private readonly preAssessments: PreAssessmentService,
  ) {}

  /**
   * Resolve the calling user → linked customer id. Returns an error
   * kind (not a thrown 403) so the controller can shape the response.
   */
  async resolveCustomerId(userId: string): Promise<ResolveResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, customerId: true },
    });
    if (!user || user.role !== "CUSTOMER" || !user.customerId) {
      return {
        ok: false,
        kind: "NotLinked",
        message: "Portal requires a CUSTOMER account linked to a customer row.",
      };
    }
    return { ok: true, customerId: user.customerId };
  }

  // ─── /me ──────────────────────────────────────────────────────────

  async getMe(customerId: string): Promise<
    LookupResult<{
      customer: Awaited<ReturnType<PrismaClient["customer"]["findUnique"]>>;
      score: { score: number; tier: string; computedAt: Date } | null;
    }>
  > {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) return { ok: false, kind: "NotFound" };
    const score = await this.scores.latestForCustomer(customerId);
    return {
      ok: true,
      value: {
        customer,
        score: score
          ? {
              score: score.score,
              tier: score.tier,
              computedAt: score.computedAt,
            }
          : null,
      },
    };
  }

  /**
   * Returns a validation complaint instead of writing when the
   * borrower CHANGED their phone to something unusable. An unchanged
   * number passes untouched, so a legacy value can't lock someone out
   * of editing their own address.
   */
  async updateProfile(customerId: string, input: ProfileUpdateInput) {
    if (input.phone !== undefined) {
      const current = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { phone: true },
      });
      const message = phoneChangeError(input.phone, current?.phone);
      if (message) {
        return {
          error: "ValidationError" as const,
          issues: [{ path: ["phone"], message }],
        };
      }
    }
    return this.prisma.customer.update({
      where: { id: customerId },
      data: input,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
        kycStatus: true,
      },
    });
  }

  // ─── loans ────────────────────────────────────────────────────────

  /**
   * The borrower's loans, each carrying its current balance.
   *
   * The balance is attached here rather than left to the client because
   * the dashboard used to derive "Outstanding" by summing the original
   * principal of active loans — telling someone who had repaid 90% of a
   * loan that they still owed all of it. The page had nothing better to
   * work with; now it does.
   */
  async listLoans(customerId: string) {
    const loans = await this.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
    });
    const balances = await this.loans.balancesFor(loans.map((l) => l.id));
    return loans.map((loan) => ({
      ...loan,
      balance: balances.get(loan.id) ?? null,
    }));
  }

  async getLoan(customerId: string, idOrNumber: string) {
    const loan = await this.loans.findByIdOrNumber(idOrNumber);
    if (!loan || loan.customerId !== customerId) {
      return { ok: false as const, kind: "NotFound" as const };
    }
    return { ok: true as const, value: loan };
  }

  async signBorrower(args: {
    customerId: string;
    loanId: string;
    signatureUrl: string;
    ip: string;
  }) {
    const loan = await this.prisma.loanApplication.findUnique({
      where: { id: args.loanId },
      select: { customerId: true },
    });
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false as const, kind: "NotFound" as const };
    }
    const updated = await this.prisma.loanApplication.update({
      where: { id: args.loanId },
      data: {
        borrowerSignatureUrl: args.signatureUrl,
        borrowerSignedAt: new Date(),
        borrowerSignedFromIp: args.ip,
      },
    });
    return { ok: true as const, value: updated };
  }

  async applyLoan(args: {
    customerId: string;
    userId: string;
    input: ApplyInput;
  }): Promise<ApplyResult> {
    const { preAssessmentId, kycAnswers, ...terms } = args.input;

    /*
     * KYC declarations — same rules as the officer path: partial
     * answers are accepted (completeness gates approval, and the
     * borrower can finish from their loan page), malformed ones are
     * rejected, and the questionnaire is snapshotted as asked.
     */
    const product = await this.prisma.loanProduct.findUnique({
      where: { code: terms.productCode },
    });
    const questions = (product?.kycQuestions ?? []) as unknown as KycQuestion[];
    let kycDeclarations: KycDeclarations | undefined;
    if (questions.length > 0) {
      const check = validateDeclarations(questions, kycAnswers ?? {});
      if (check.invalid.length > 0) {
        return {
          ok: false,
          kind: "RepoError",
          message: "One or more declaration answers are malformed.",
          issues: check.invalid,
        };
      }
      kycDeclarations = snapshotDeclarations(questions, kycAnswers ?? {}, {
        id: args.userId,
      });
    }

    const score = await this.scores.latestForCustomer(args.customerId);
    try {
      const created = await this.loans.apply({
        ...terms,
        customerId: args.customerId,
        submittedById: args.userId,
        creditScoreAtApply: score?.score ?? null,
        tierAtApply: score?.tier ?? null,
        kycDeclarations,
      });
      // Link the check the borrower ran before applying. Best-effort: the
      // loan is committed, and a stale or already-claimed assessment id is
      // not a reason to fail an application that succeeded.
      if (preAssessmentId) {
        try {
          await this.preAssessments.markConverted(preAssessmentId, created.id);
        } catch {
          // Non-fatal — the loan stands on its own.
        }
      }
      return { ok: true, loan: created };
    } catch (err) {
      /*
       * This path had NO live-loan check of its own. The officer
       * console's guard lived in LoanWorkflowService, which the portal
       * doesn't go through — it calls the repository directly — so a
       * borrower could apply again from their own dashboard while a
       * loan was approved and awaiting disbursement. The repository now
       * enforces it for both, and this maps the refusal.
       *
       * Reworded for the person reading it: the officer's version says
       * "this customer", which is nonsense addressed to the customer.
       */
      if (err instanceof CustomerHasLiveLoanError) {
        const numbers = err.liveLoans.map((l) => l.number).join(", ");
        return {
          ok: false,
          kind: "HasLiveLoan",
          message:
            err.liveLoans.length === 1
              ? `You already have an open loan (${numbers}). It has to be settled before you can apply again.`
              : `You already have open loans (${numbers}). They have to be settled before you can apply again.`,
          liveLoans: err.liveLoans.map((l) => ({
            id: l.id,
            number: l.number,
            status: l.status,
          })),
        };
      }
      const e = err as Error & { issues?: unknown };
      return {
        ok: false,
        kind: "RepoError",
        message: e.message,
        issues: e.issues,
      };
    }
  }

  /**
   * The borrower answering their own declarations — the portal's
   * KYC-stage capture. Ownership-scoped like every portal write, and
   * frozen once the loan is decided, same as the officer path: the
   * answers are part of what approval judged.
   */
  async answerDeclarations(args: {
    customerId: string;
    userId: string;
    loanIdOrNumber: string;
    answers: KycAnswers;
  }): Promise<
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
    const loan = await this.loans.findByIdOrNumber(args.loanIdOrNumber);
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false, kind: "NotFound" };
    }
    if (!["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(loan.status)) {
      return { ok: false, kind: "NotEditable", status: loan.status };
    }

    const current = loan.kycDeclarations as KycDeclarations | null;
    let next: KycDeclarations;
    if (current && current.items.length > 0) {
      const merged = answerDeclarations(current, args.answers, {
        id: args.userId,
      });
      if (!merged.ok) {
        return { ok: false, kind: "InvalidAnswers", invalid: merged.invalid };
      }
      next = merged.next;
    } else {
      const questions = (loan.product?.kycQuestions ??
        []) as unknown as KycQuestion[];
      if (questions.length === 0) return { ok: false, kind: "NoQuestionnaire" };
      const check = validateDeclarations(questions, args.answers);
      if (check.invalid.length > 0) {
        return { ok: false, kind: "InvalidAnswers", invalid: check.invalid };
      }
      next = snapshotDeclarations(questions, args.answers, {
        id: args.userId,
      });
    }

    await this.prisma.loanApplication.update({
      where: { id: loan.id },
      data: { kycDeclarations: next as never },
    });
    return { ok: true, declarations: next };
  }

  // ─── pre-assessment ───────────────────────────────────────────────

  /**
   * "Would I be approved for this?" — run before committing to an
   * application. Same engine as the officer's, and because the caller is a
   * real customer their score, AML status and KYC pack are all in play, so
   * the verdict is a genuine preview rather than an estimate.
   *
   * `customerId` is forced from the JWT subject; the body carries only the
   * loan terms, so a borrower can't assess anyone but themselves.
   */
  async preAssess(args: {
    customerId: string;
    userId: string;
    input: PortalPreAssessmentInput;
  }) {
    return this.preAssessments.run({
      input: { ...args.input, customerId: args.customerId },
      source: "PORTAL",
      actorId: args.userId,
    });
  }

  listPreAssessments(customerId: string) {
    return this.preAssessments.listForCustomer(customerId);
  }

  // ─── KYC ─────────────────────────────────────────────────────────

  async listKyc(customerId: string) {
    const docs = await this.kyc.listForCustomer(customerId);
    return { docs, status: validateKyc(docs) };
  }

  submitKyc(args: {
    customerId: string;
    userId: string;
    input: KycSubmitInput;
  }) {
    return this.kyc.submit({
      customerId: args.customerId,
      documentType: args.input.documentType,
      documentUrl: args.input.documentUrl,
      notes: args.input.notes,
      submittedById: args.userId,
    });
  }

  // ─── payments ─────────────────────────────────────────────────────

  async createIntent(args: {
    customerId: string;
    userId: string;
    input: IntentInput;
  }) {
    const loan = await this.prisma.loanApplication.findUnique({
      where: { id: args.input.loanId },
      select: { customerId: true },
    });
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false as const, kind: "NotFound" as const };
    }
    const intent = await this.intents.create({
      loanId: args.input.loanId,
      amount: args.input.amount,
      idempotencyKey: randomUUID(),
      webhookUrl: this.intentWebhookUrl,
      createdById: args.userId,
    });
    return { ok: true as const, value: intent };
  }

  async getIntent(customerId: string, idOrNumber: string) {
    const intent = await this.intents.findByIdOrNumber(idOrNumber);
    if (!intent) return { ok: false as const, kind: "NotFound" as const };
    const loan = await this.prisma.loanApplication.findUnique({
      where: { id: intent.loanId },
      select: { customerId: true },
    });
    if (loan?.customerId !== customerId) {
      return { ok: false as const, kind: "NotFound" as const };
    }
    return { ok: true as const, value: intent };
  }

  // ─── ledgers ──────────────────────────────────────────────────────

  async memberLedger(customerId: string) {
    const result = await this.coop.memberLedger(customerId);
    if (!result) return { ok: false as const, kind: "NotFound" as const };
    return { ok: true as const, value: result };
  }

  customerLedger(customerId: string, opts: LedgerOpts) {
    return this.ledger.build(customerId, opts);
  }

  /**
   * Render the combined statement of account as a PDF. Pulls the
   * current branding (company name / logo) so the document carries the
   * cooperative's identity, not the framework default.
   */
  async customerLedgerPdf(
    customerId: string,
    opts: LedgerOpts,
  ): Promise<Buffer> {
    const data = await this.ledger.build(customerId, opts);
    const branding = await getBranding(this.prisma);
    return renderCustomerStatement({
      companyName: branding.companyName,
      asOf: new Date(data.asOf),
      range: {
        from: data.range.from ? new Date(data.range.from) : null,
        to: data.range.to ? new Date(data.range.to) : null,
      },
      scope: data.scope,
      customer: data.customer,
      summary: data.summary,
      entries: data.entries.map((e) => ({ ...e, date: new Date(e.date) })),
    });
  }

  // ─── cooperative history ──────────────────────────────────────────

  listContributions(customerId: string) {
    return this.prisma.contribution.findMany({
      where: { customerId },
      orderBy: { contributedAt: "desc" },
    });
  }

  listSavings(customerId: string) {
    return this.prisma.savingsTransaction.findMany({
      where: { customerId },
      orderBy: { txnDate: "desc" },
    });
  }
}
