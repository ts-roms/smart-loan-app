/**
 * Payment intent repository.
 *
 * Flow:
 *   1. createIntent(loan, amount, idempotencyKey) — calls the provider's
 *      `createIntent`, persists a row, returns the payment URL.
 *   2. Customer pays via the provider.
 *   3. Provider POSTs the webhook to our API.
 *   4. The API route validates the payload, then calls
 *      `handleWebhookPaid` which marks the intent PAID and creates a
 *      LoanPayment (which itself auto-posts the journal entry).
 *
 * Idempotency: same `idempotencyKey` on create returns the existing intent
 * instead of double-charging.
 */

import type {
  CreateIntentInput,
  PaymentProvider,
  PaymentProviderName,
} from "@loan/payments";
import type {
  LoanPayment,
  PaymentIntent,
  PaymentIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { LoanRepository } from "./loan.repository.js";
import {
  idOrNumberWhere,
  nextPaymentIntentNumber,
} from "../lib/reference-numbers.js";

export interface CreatePaymentIntentInput {
  loanId: string;
  amount: number;
  description?: string;
  createdById: string;
  idempotencyKey: string;
  webhookUrl: string;
  returnUrl?: string;
}

export class PaymentIntentRepository {
  private readonly loans: LoanRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PaymentProvider,
  ) {
    this.loans = new LoanRepository(prisma);
  }

  list(loanId: string): Promise<PaymentIntent[]> {
    return this.prisma.paymentIntent.findMany({
      where: { loanId },
      orderBy: { createdAt: "desc" },
    });
  }

  findById(id: string): Promise<PaymentIntent | null> {
    return this.prisma.paymentIntent.findUnique({ where: { id } });
  }

  findByExternalId(
    provider: PaymentProviderName,
    externalId: string,
  ): Promise<PaymentIntent | null> {
    return this.prisma.paymentIntent.findUnique({
      where: {
        provider_externalId: { provider: provider as never, externalId },
      },
    });
  }

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    // Idempotency: return the existing intent if the key has been used.
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;

    const providerInput: CreateIntentInput = {
      loanId: input.loanId,
      amount: input.amount,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      webhookUrl: input.webhookUrl,
      returnUrl: input.returnUrl,
    };
    const created = await this.provider.createIntent(providerInput);
    const number = await nextPaymentIntentNumber(this.prisma);
    return this.prisma.paymentIntent.create({
      data: {
        number,
        loanId: input.loanId,
        provider: this.provider.name as never,
        externalId: created.externalId,
        idempotencyKey: input.idempotencyKey,
        amount: input.amount,
        paymentUrl: created.paymentUrl,
        status: created.status as never,
        createdById: input.createdById,
      },
    });
  }

  /**
   * Resolve a payment intent by either UUID or "PI-..." number.
   * Mirrors the same id-or-number convention used by other repos.
   */
  findByIdOrNumber(idOrNumber: string): Promise<PaymentIntent | null> {
    return this.prisma.paymentIntent.findFirst({
      where: idOrNumberWhere(idOrNumber),
    });
  }

  /**
   * Apply a parsed webhook event. If the event is PAID and the intent is
   * still CREATED/PROCESSING, this records a LoanPayment (which auto-posts
   * the journal entry) and links it back to the intent.
   *
   * Idempotent: once an intent is in a terminal status we no-op.
   */
  async handleWebhook(args: {
    provider: PaymentProviderName;
    externalId: string;
    status: PaymentIntentStatus;
    amount?: number;
    reference?: string;
  }): Promise<{ intent: PaymentIntent; payment: LoanPayment | null }> {
    const intent = await this.findByExternalId(args.provider, args.externalId);
    if (!intent) {
      throw new Error(`Unknown intent: ${args.provider}/${args.externalId}`);
    }
    // Already terminal? No-op.
    if (
      intent.status === "PAID" ||
      intent.status === "FAILED" ||
      intent.status === "EXPIRED"
    ) {
      return { intent, payment: null };
    }

    if (args.status !== "PAID") {
      const updated = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: args.status as never, resolvedAt: new Date() },
      });
      return { intent: updated, payment: null };
    }

    // PAID — record the loan payment + link.
    const payment = await this.loans.recordPayment(intent.loanId, {
      amount: args.amount ?? Number(intent.amount),
      paidOn: new Date(),
      reference: args.reference ?? intent.externalId,
      recordedById: intent.createdById,
    });
    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "PAID" as never,
        resolvedAt: new Date(),
        paymentId: payment.id,
      },
    });
    return { intent: updated, payment };
  }
}
