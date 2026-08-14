/**
 * Invariant (§48): a notification failure must not break the financial
 * transaction that triggered it.
 *
 * This was free while every provider was a mock that could not fail. It is
 * load-bearing now that `SendGridProvider` and `TwilioProvider` issue real
 * HTTP: an expired API key, a 429, a DNS failure or a hung socket are all
 * ordinary Tuesday events, and several call sites await a dispatch inside
 * the request path AFTER the money has moved —
 * `loans.service.ts` does exactly that for LOAN_DISBURSED, and
 * `ledger.service.ts` awaits STATEMENT_READY with no try/catch at all, so a
 * throw there would surface as a 500 on a route whose financial work
 * already committed.
 *
 * The contract these tests pin:
 *
 *   1. A provider that throws resolves the dispatch, it does not reject.
 *   2. The failure is recorded on the Notification row as FAILED, with the
 *      provider's message, so an operator can see it in the inbox.
 *   3. Nothing about the failure path depends on WHICH provider failed.
 *
 * No database and no network: the Prisma stand-in records the writes.
 */

import { NotificationDeliveryError } from "@loan/notifications";
import type {
  Channel,
  NotificationProvider,
  SendInput,
  SendResult,
} from "@loan/notifications";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { NotificationRepository } from "./notification.repository";

/** Records every notification write so we can assert the final state. */
function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n-${String(rows.length + 1)}`, ...data };
        rows.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        updates.push(data);
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { client: client as unknown as PrismaClient, rows, updates };
}

class ThrowingProvider implements NotificationProvider {
  readonly channels: ReadonlySet<Channel> = new Set<Channel>([
    "EMAIL",
    "SMS",
    "IN_APP",
  ]);
  constructor(
    public readonly name: string,
    private readonly err: Error,
  ) {}
  send(_input: SendInput): Promise<SendResult> {
    return Promise.reject(this.err);
  }
}

const DISBURSED = {
  event: "LOAN_DISBURSED",
  channel: "EMAIL",
  recipient: "borrower@example.com",
  data: { customerName: "Juan Dela Cruz", loanNumber: "LN-1", amount: 50000 },
} as const;

describe("a provider failure does not reach the caller", () => {
  it("resolves rather than rejecting when the provider throws", async () => {
    const { client } = fakePrisma();
    const repo = new NotificationRepository(
      client,
      new ThrowingProvider(
        "SENDGRID",
        new NotificationDeliveryError("SENDGRID", "HTTP 401 — Unauthorized"),
      ),
    );

    // The assertion that matters: no throw. A disbursement that has
    // already committed must not be reported as a failure because the
    // receipt email bounced.
    await expect(repo.dispatch({ ...DISBURSED })).resolves.toBeDefined();
  });

  it("records the failure on the row instead of losing it", async () => {
    const { client, rows } = fakePrisma();
    const repo = new NotificationRepository(
      client,
      new ThrowingProvider(
        "TWILIO",
        new NotificationDeliveryError("TWILIO", "HTTP 429 — Too Many Requests"),
      ),
    );

    const row = await repo.dispatch({ ...DISBURSED, channel: "SMS" });
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/TWILIO send failed: HTTP 429/);
    // One row, transitioned — not a second row, and not a silent drop.
    expect(rows).toHaveLength(1);
  });

  it("holds for a timeout, which is the failure mode that would hang a request", async () => {
    const { client } = fakePrisma();
    const repo = new NotificationRepository(
      client,
      new ThrowingProvider(
        "SENDGRID",
        new NotificationDeliveryError("SENDGRID", "timed out after 10000ms"),
      ),
    );

    const row = await repo.dispatch({ ...DISBURSED });
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/timed out/);
  });

  it("holds for an arbitrary error, not just our own error type", async () => {
    const { client } = fakePrisma();
    const repo = new NotificationRepository(
      client,
      new ThrowingProvider("SENDGRID", new TypeError("fetch failed")),
    );

    const row = await repo.dispatch({ ...DISBURSED });
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("fetch failed");
  });
});

describe("the success path still records what it should", () => {
  it("marks SENT and keeps the provider reference", async () => {
    const { client } = fakePrisma();
    const provider: NotificationProvider = {
      name: "SENDGRID",
      channels: new Set<Channel>(["EMAIL"]),
      send: async () => ({ providerRef: "msg-abc123" }),
    };

    const row = await new NotificationRepository(client, provider).dispatch({
      ...DISBURSED,
    });
    expect(row.status).toBe("SENT");
    expect(row.providerRef).toBe("msg-abc123");
    expect(row.sentAt).toBeInstanceOf(Date);
  });

  /*
   * Twilio returns a 201 whose body we may fail to parse. The adapter
   * reports success with no reference rather than manufacturing a failure
   * for a message the provider has — so the row must still be SENT.
   */
  it("marks SENT even when the provider returned no reference", async () => {
    const { client } = fakePrisma();
    const provider: NotificationProvider = {
      name: "TWILIO",
      channels: new Set<Channel>(["SMS"]),
      send: async () => ({}),
    };

    const row = await new NotificationRepository(client, provider).dispatch({
      ...DISBURSED,
      channel: "SMS",
    });
    expect(row.status).toBe("SENT");
    expect(row.providerRef).toBeUndefined();
  });
});
