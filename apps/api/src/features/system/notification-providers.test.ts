/**
 * Per-tenant notification provider routing.
 *
 * Two things are in scope. The first is the channel-routing decision:
 * given a SystemConfig + an inbound `send(input)`, does the right
 * provider get the call?
 *
 *   - SMS with full Twilio creds → tenant Twilio provider
 *   - SMS without Twilio creds → fallback
 *   - SMS with PARTIAL Twilio creds (missing the from-number) → fallback
 *   - EMAIL with full SendGrid creds → tenant SendGrid provider
 *   - EMAIL without creds → fallback
 *   - IN_APP → always fallback (no per-tenant routing today)
 *
 * The second is new, and is the reason these tests now inject a fetch:
 * the tenant branches build REAL providers, so it is no longer enough to
 * show the fallback was skipped. The tenant's own credentials have to
 * reach the outbound request — a builder that ignored its config would
 * have passed every assertion in the original version of this file.
 *
 * The injected fetch also means these tests still make no network call
 * and need no credentials.
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

/**
 * Stands in for the network. A tenant branch that reaches this has built
 * a real provider; a fallback branch never touches it.
 */
function fakeFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 202,
    statusText: "",
    headers: new Headers(),
    text: async () => "",
    json: async () => ({ sid: "SMtest" }),
  });
}

/**
 * The outbound request a tenant branch produced, as a plain object.
 *
 * Both adapters always pass a string body and a plain header map, so the
 * init is narrowed to that rather than the wider `RequestInit`.
 */
function sentRequest(f: ReturnType<typeof fakeFetch>) {
  expect(f).toHaveBeenCalledOnce();
  const [url, init] = f.mock.calls[0]! as [
    string,
    { headers: Record<string, string>; body: string },
  ];
  return { url, headers: init.headers, body: init.body };
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
    const f = fakeFetch();
    const prisma = makePrisma({
      twilioAccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioAuthToken: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      twilioFromNumber: "+15551234567",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
      { fetchImpl: f as unknown as typeof fetch },
    );

    await wrapper.send(SMS_INPUT);
    // Fallback did NOT see the call — it went to the tenant Twilio.
    expect(fallback.calls).toHaveLength(0);
    expect(f).toHaveBeenCalledOnce();
  });

  /*
   * The regression that matters most in this file. Both builders used to
   * `void cfg` and return a tagged mock, so "the fallback was skipped" was
   * true while the tenant's credentials went nowhere. These two assert the
   * credentials are actually in the request.
   */
  it("puts the tenant's OWN Twilio credentials in the outbound request", async () => {
    const f = fakeFetch();
    const prisma = makePrisma({
      twilioAccountSid: "ACtenant0000000000000000000000001",
      twilioAuthToken: "tenant-auth-token",
      twilioFromNumber: "+15559876543",
    });
    await new TenantAwareNotificationProvider(
      prisma as never,
      new RecordingProvider("fallback"),
      { fetchImpl: f as unknown as typeof fetch },
    ).send(SMS_INPUT);

    const req = sentRequest(f);
    // The tenant's account SID selects the REST resource…
    expect(req.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACtenant0000000000000000000000001/Messages.json",
    );
    // …its auth token signs the request…
    expect(
      Buffer.from(
        req.headers.authorization!.replace("Basic ", ""),
        "base64",
      ).toString("utf8"),
    ).toBe("ACtenant0000000000000000000000001:tenant-auth-token");
    // …and its from-number is the sender, not the platform's.
    expect(new URLSearchParams(req.body).get("From")).toBe("+15559876543");
    expect(new URLSearchParams(req.body).get("To")).toBe("+639171234567");
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
    const f = fakeFetch();
    const prisma = makePrisma({
      sendgridApiKey: "SG.xxxxxxxxxxxxxxxxxxxxx",
      sendgridFromEmail: "noreply@acme-coop.com",
    });
    const wrapper = new TenantAwareNotificationProvider(
      prisma as never,
      fallback,
      { fetchImpl: f as unknown as typeof fetch },
    );

    await wrapper.send(EMAIL_INPUT);
    expect(fallback.calls).toHaveLength(0);
    expect(f).toHaveBeenCalledOnce();
  });

  it("puts the tenant's OWN SendGrid credentials in the outbound request", async () => {
    const f = fakeFetch();
    const prisma = makePrisma({
      sendgridApiKey: "SG.tenant-key",
      sendgridFromEmail: "billing@acme-coop.com",
      sendgridFromName: "Acme Coop Billing",
    });
    await new TenantAwareNotificationProvider(
      prisma as never,
      new RecordingProvider("fallback"),
      { fetchImpl: f as unknown as typeof fetch },
    ).send(EMAIL_INPUT);

    const req = sentRequest(f);
    expect(req.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(req.headers.authorization).toBe("Bearer SG.tenant-key");
    // The tenant's own sender identity, including the display name that
    // the old stub discarded along with everything else.
    expect((JSON.parse(req.body) as { from: unknown }).from).toEqual({
      email: "billing@acme-coop.com",
      name: "Acme Coop Billing",
    });
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
