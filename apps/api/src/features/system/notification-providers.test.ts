/**
 * Per-tenant notification provider routing.
 *
 * The scope of these tests is the channel-routing decision: given a
 * SystemConfig + an inbound `send(input)`, does the right provider
 * get the call?
 *
 *   - SMS with full Twilio creds → tenant Twilio provider
 *   - SMS without Twilio creds → fallback
 *   - SMS with PARTIAL Twilio creds (missing the from-number) → fallback
 *   - EMAIL with full SendGrid creds → tenant SendGrid provider
 *   - EMAIL without creds → fallback
 *   - IN_APP → always fallback (no per-tenant routing today)
 */

import type {
  Channel,
  NotificationProvider,
  SendInput,
  SendResult,
} from "@loan/notifications";
import { describe, expect, it, vi } from "vitest";

import { TenantAwareNotificationProvider } from "./notification-providers";

interface TenantProviderConfig {
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFromNumber: string | null;
  sendgridApiKey: string | null;
  sendgridFromEmail: string | null;
  sendgridFromName: string | null;
}

function makePrisma(cfg: Partial<TenantProviderConfig>) {
  const full: TenantProviderConfig = {
    twilioAccountSid: null,
    twilioAuthToken: null,
    twilioFromNumber: null,
    sendgridApiKey: null,
    sendgridFromEmail: null,
    sendgridFromName: null,
    ...cfg,
  };
  return {
    systemConfig: {
      upsert: vi.fn(async (_args: unknown) => full),
    },
  };
}

class RecordingProvider implements NotificationProvider {
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);
  readonly calls: SendInput[] = [];
  constructor(public readonly name: string) {}
  async send(input: SendInput): Promise<SendResult> {
    this.calls.push(input);
    return { providerRef: `${this.name}-ref` };
  }
}

const SMS_INPUT: SendInput = {
  channel: "SMS",
  recipient: "+639171234567",
  body: "Your payment is due.",
};

const EMAIL_INPUT: SendInput = {
  channel: "EMAIL",
  recipient: "borrower@example.com",
  subject: "Payment due",
  body: "Your payment is due.",
};

const IN_APP_INPUT: SendInput = {
  channel: "IN_APP",
  recipient: "user-id-1",
  body: "Bell notification",
};

describe("TenantAwareNotificationProvider — channel routing", () => {
  it("routes SMS through the fallback when no Twilio creds are set", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({});
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    const result = await wrapper.send(SMS_INPUT);
    expect(fallback.calls).toHaveLength(1);
    expect(result.providerRef).toBe("fallback-ref");
  });

  it("routes SMS through the tenant Twilio provider when all three Twilio fields are set", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({
      twilioAccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioAuthToken: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioFromNumber: "+15551234567",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(SMS_INPUT);
    // Fallback did NOT see the call — it went to the tenant Twilio.
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back when Twilio creds are PARTIAL (auth token missing)", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({
      twilioAccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioAuthToken: null, // operator only pasted SID + from-number
      twilioFromNumber: "+15551234567",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(SMS_INPUT);
    // All-or-nothing: partial config doesn't route to the tenant
    // provider (we'd just get a Twilio auth error).
    expect(fallback.calls).toHaveLength(1);
  });

  it("routes EMAIL through the tenant SendGrid when key + from-email are set", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({
      sendgridApiKey: "SG.xxxxxxxxxxxxxxxxxxxxx",
      sendgridFromEmail: "noreply@acme-coop.com",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(EMAIL_INPUT);
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back for EMAIL when only the API key is set (no from-email)", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({
      sendgridApiKey: "SG.xxxxxxxxxxxxxxxxxxxxx",
      sendgridFromEmail: null,
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(EMAIL_INPUT);
    expect(fallback.calls).toHaveLength(1);
  });

  it("routes IN_APP through the fallback regardless of provider config", async () => {
    const fallback = new RecordingProvider("fallback");
    // Both providers fully configured — IN_APP should STILL go to fallback
    // since it's a DB-only "bell" notification with no external provider.
    const prisma = makePrisma({
      twilioAccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioAuthToken: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioFromNumber: "+15551234567",
      sendgridApiKey: "SG.xxxxxxxxxxxxxxxxxxxxx",
      sendgridFromEmail: "noreply@acme-coop.com",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(IN_APP_INPUT);
    expect(fallback.calls).toHaveLength(1);
  });

  it("re-reads SystemConfig on every send (no caching)", async () => {
    const fallback = new RecordingProvider("fallback");
    const prisma = makePrisma({});
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
    );

    await wrapper.send(SMS_INPUT);
    await wrapper.send(SMS_INPUT);
    await wrapper.send(SMS_INPUT);
    // Three sends → three SystemConfig lookups. Per-call resolution
    // means an operator pasting fresh creds sees them apply
    // immediately, without a process restart.
    expect(prisma.systemConfig.upsert).toHaveBeenCalledTimes(3);
  });
});
