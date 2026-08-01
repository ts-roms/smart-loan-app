import {
  type CooperativeRepository,
  type CreditScoreRepository,
  type CustomerLedgerRepository,
  type KycRepository,
  type LoanRepository,
  type PaymentIntentRepository,
  type PrismaClient,
} from "@loan/db";
import { validateKyc } from "@loan/kyc";
import { renderCustomerStatement } from "@loan/pdf";
import { randomUUID } from "node:crypto";

import { getBranding } from "../../lib/branding";

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
  | { ok: false; kind: "RepoError"; message: string; issues?: unknown };

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

  async updateProfile(customerId: string, input: ProfileUpdateInput) {
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

  listLoans(customerId: string) {
    return this.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
    });
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
    const score = await this.scores.latestForCustomer(args.customerId);
    try {
      const created = await this.loans.apply({
        ...args.input,
        customerId: args.customerId,
        submittedById: args.userId,
        creditScoreAtApply: score?.score ?? null,
        tierAtApply: score?.tier ?? null,
      });
      return { ok: true, loan: created };
    } catch (err) {
      const e = err as Error & { issues?: unknown };
      return {
        ok: false,
        kind: "RepoError",
        message: e.message,
        issues: e.issues,
      };
    }
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
