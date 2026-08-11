import type { LoanPayment, PaymentIntent, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PaymentIntentRepository } from "./payment-intent.repository";

/**
 * Invariant: one settlement produces one payment, however many times
 * the provider delivers the webhook.
 *
 * The last P0 from the Phase 0 audit. `handleWebhook` checked whether
 * the intent was already terminal and, if not, recorded a payment —
 * a check-then-act. Payment providers (GCash, Maya, Dragonpay and
 * every other gateway worth the name) deliver **at least once**:
 * retries on timeout, retries on a non-2xx, and duplicate deliveries
 * are all normal. Two copies of one webhook therefore both read a
 * PENDING intent, both passed the terminal check, and both called
 * recordPayment with no idempotency key — two real payments for money
 * that arrived once.
 *
 * The fix derives the key from the INTENT, not the request: a retry is
 * a redelivery of the same event and must produce the same key however
 * the provider varies its payload between attempts.
 */

const INTENT_ID = "intent-1";
const KEY = `intent:${INTENT_ID}`;

function intent(status: string): PaymentIntent {
  return {
    id: INTENT_ID,
    loanId: "loan-1",
    externalId: "EXT-123",
    provider: "MOCK",
    status,
    amount: 2_500,
    createdById: "u1",
  } as unknown as PaymentIntent;
}

/**
 * Loan repository stand-in whose `recordPayment` honours the
 * idempotency key the way the real one does: same key, same payment.
 */
function fakeLoans() {
  const byKey = new Map<string, LoanPayment>();
  let created = 0;
  return {
    calls: () => created,
    distinctPayments: () => byKey.size,
    recordPayment: (
      _loanId: string,
      input: { idempotencyKey?: string; amount: number },
    ) => {
      created += 1;
      const key = input.idempotencyKey;
      if (key && byKey.has(key)) return Promise.resolve(byKey.get(key)!);
      const payment = {
        id: `pay-${byKey.size + 1}`,
        idempotencyKey: key ?? null,
        amount: input.amount,
      } as unknown as LoanPayment;
      if (key) byKey.set(key, payment);
      return Promise.resolve(payment);
    },
  };
}

function fakePrisma(initial: string) {
  const state = { status: initial, paymentId: null as string | null };
  const client = {
    paymentIntent: {
      findFirst: () => Promise.resolve(intent(state.status)),
      findUnique: () => Promise.resolve(intent(state.status)),
      update: ({ data }: { data: { status?: string; paymentId?: string } }) => {
        if (data.status) state.status = data.status;
        if (data.paymentId) state.paymentId = data.paymentId;
        return Promise.resolve(intent(state.status));
      },
    },
    __state: state,
  };
  return client as unknown as PrismaClient & { __state: typeof state };
}

const PROVIDER = { name: "MOCK" } as never;

/**
 * The repository builds its own LoanRepository in the constructor, so
 * the seam is the field rather than an argument.
 */
function build(
  prisma: PrismaClient,
  loans: ReturnType<typeof fakeLoans>,
): PaymentIntentRepository {
  const repo = new PaymentIntentRepository(prisma, PROVIDER);
  (repo as unknown as { loans: unknown }).loans = loans;
  return repo;
}

const webhook = (repo: PaymentIntentRepository) =>
  repo.handleWebhook({
    provider: "MOCK",
    externalId: "EXT-123",
    status: "PAID",
    amount: 2_500,
  });

describe("handleWebhook — one settlement, one payment", () => {
  it("passes a key derived from the intent", async () => {
    const loans = fakeLoans();
    const repo = build(fakePrisma("PENDING"), loans);

    const result = await webhook(repo);

    expect(result.payment?.idempotencyKey).toBe(KEY);
  });

  it("two deliveries of the same webhook yield one payment", async () => {
    /*
     * The at-least-once case. Both deliveries reach recordPayment —
     * the terminal check cannot stop them, which is the whole point —
     * and the key is what makes the second a replay rather than a
     * second charge.
     */
    const loans = fakeLoans();
    const prisma = fakePrisma("PENDING");
    const repo = build(prisma, loans);

    const first = await webhook(repo);
    // Force the second delivery down the same path by rewinding the
    // intent, modelling two in-flight requests that both read PENDING.
    prisma.__state.status = "PENDING";
    const second = await webhook(repo);

    expect(loans.calls()).toBe(2);
    expect(loans.distinctPayments()).toBe(1);
    expect(second.payment?.id).toBe(first.payment?.id);
  });

  it("still short-circuits an already-settled intent", async () => {
    // The terminal check is not the guarantee, but it is still worth
    // having: a redelivery long after settlement should not even reach
    // the loan repository.
    const loans = fakeLoans();
    const repo = build(fakePrisma("PAID"), loans);

    const result = await webhook(repo);

    expect(loans.calls()).toBe(0);
    expect(result.payment).toBeNull();
  });

  it("records no payment for a non-PAID status", async () => {
    const loans = fakeLoans();
    const repo = build(fakePrisma("PENDING"), loans);

    const result = await repo.handleWebhook({
      provider: "MOCK",
      externalId: "EXT-123",
      status: "FAILED",
    });

    expect(loans.calls()).toBe(0);
    expect(result.payment).toBeNull();
  });

  it("refuses a webhook for an intent it does not know", async () => {
    const loans = fakeLoans();
    const prisma = {
      paymentIntent: {
        findFirst: () => Promise.resolve(null),
        findUnique: () => Promise.resolve(null),
      },
    } as unknown as PrismaClient;
    const repo = build(prisma, loans);

    await expect(
      repo.handleWebhook({
        provider: "MOCK",
        externalId: "NOPE",
        status: "PAID",
      }),
    ).rejects.toThrow(/Unknown intent/);
  });
});
