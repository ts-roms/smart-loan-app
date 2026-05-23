/**
 * Per-tenant notification-provider resolution.
 *
 * Each tenant can bring its own Twilio (SMS) + SendGrid (EMAIL)
 * credentials, stored as plaintext columns on `SystemConfig`. The
 * `TenantAwareProvider` below reads SystemConfig on every dispatch
 * and routes the send to either the tenant's own provider or the
 * platform-shared fallback.
 *
 * ## Design: per-call SystemConfig read
 *
 * The simplest model is to read `SystemConfig` once at request
 * boot and cache. But the per-request preHandler already builds a
 * fresh repo per request; a single extra row read per dispatch is
 * negligible (sub-millisecond on the local schema). And the per-call
 * model means an operator who pastes in a Twilio key sees the next
 * SMS use it immediately — no restart, no cache to invalidate.
 *
 * ## Design: fallback is per-channel, not per-tenant
 *
 * A tenant with only SendGrid set still uses the platform's SMS
 * provider for the SMS channel. That's intentional: tenants
 * onboarding gradually shouldn't have to fill in every column to
 * start sending email. Each channel decides independently.
 *
 * ## Today's reality vs. tomorrow's
 *
 * The actual Twilio + SendGrid clients are still placeholders in
 * `providers.ts` — when `NOTIFICATION_PROVIDER=TWILIO` is set, the
 * factory falls back to MOCK with a warn-log. This file wires the
 * CREDENTIAL PATH so the moment a real provider class lands, the
 * per-tenant override flows through without changes elsewhere.
 *
 * The columns on SystemConfig + the admin endpoints are the
 * shippable piece TODAY. The real-provider implementation is a
 * separate commit.
 */

import type {
  NotificationProvider,
  SendInput,
  SendResult,
  Channel,
} from "@loan/notifications";
import { MockNotificationProvider } from "@loan/notifications";
import type { PrismaClient } from "@loan/db";

interface TenantProviderConfig {
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFromNumber: string | null;
  sendgridApiKey: string | null;
  sendgridFromEmail: string | null;
  sendgridFromName: string | null;
}

/**
 * Wraps a fallback provider + a per-tenant Prisma client. On every
 * `send()`, checks SystemConfig to decide whether to use the
 * tenant's own provider for the requested channel or the fallback.
 *
 * Pure stub today: when a tenant has Twilio creds configured, the
 * SMS branch logs `provider:twilio (tenant)` instead of `mock`. When
 * the real Twilio client class lands in @loan/notifications, swap
 * the `buildTenantProvider*` helpers below to construct + dispatch
 * through it.
 */
export class TenantAwareNotificationProvider implements NotificationProvider {
  readonly name = "tenant-aware";
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fallback: NotificationProvider,
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    const cfg = await this.loadCfg();
    const provider = this.pickProvider(input.channel, cfg);
    return provider.send(input);
  }

  private async loadCfg(): Promise<TenantProviderConfig> {
    // SystemConfig is a singleton row (id="singleton"). Upsert with
    // an empty update so a fresh tenant never returns null and we
    // don't have to fork on missing-row.
    return this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: {
        twilioAccountSid: true,
        twilioAuthToken: true,
        twilioFromNumber: true,
        sendgridApiKey: true,
        sendgridFromEmail: true,
        sendgridFromName: true,
      },
    });
  }

  private pickProvider(
    channel: Channel,
    cfg: TenantProviderConfig,
  ): NotificationProvider {
    if (channel === "SMS" && hasTwilio(cfg)) {
      return buildTenantTwilioProvider(cfg);
    }
    if (channel === "EMAIL" && hasSendgrid(cfg)) {
      return buildTenantSendgridProvider(cfg);
    }
    return this.fallback;
  }
}

// ─── Type guards ─────────────────────────────────────────────────────

function hasTwilio(cfg: TenantProviderConfig): cfg is TenantProviderConfig & {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
} {
  return Boolean(
    cfg.twilioAccountSid && cfg.twilioAuthToken && cfg.twilioFromNumber,
  );
}

function hasSendgrid(cfg: TenantProviderConfig): cfg is TenantProviderConfig & {
  sendgridApiKey: string;
  sendgridFromEmail: string;
} {
  return Boolean(cfg.sendgridApiKey && cfg.sendgridFromEmail);
}

// ─── Provider builders ───────────────────────────────────────────────
//
// Today's implementations are MOCK-with-attribution: they log the
// tenant-overridden send so operators can verify the override is
// active. When the real Twilio + SendGrid clients land, replace
// the bodies below with the real client constructors. The signatures
// stay the same.

function buildTenantTwilioProvider(cfg: {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
}): NotificationProvider {
  // Pure stub. When @loan/notifications gets a real TwilioProvider
  // class, do:
  //   return new TwilioProvider({
  //     accountSid: cfg.twilioAccountSid,
  //     authToken: cfg.twilioAuthToken,
  //     fromNumber: cfg.twilioFromNumber,
  //   });
  void cfg;
  return new TaggedMockProvider("twilio (tenant)");
}

function buildTenantSendgridProvider(cfg: {
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName?: string | null;
}): NotificationProvider {
  void cfg;
  return new TaggedMockProvider("sendgrid (tenant)");
}

/**
 * Mock provider that reports a custom name in the audit trail. Used
 * until real Twilio/SendGrid clients are implemented. Lets the
 * Notification row's `provider` column show `twilio (tenant)` vs
 * `MOCK` so operators can verify the per-tenant override is
 * actually taking effect.
 */
class TaggedMockProvider implements NotificationProvider {
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);
  constructor(public readonly name: string) {}

  async send(input: SendInput): Promise<SendResult> {
    // Inherit the mock's behavior — log + return a synthetic
    // providerRef so the Notification row stays consistent.
    const inner = new MockNotificationProvider();
    return inner.send(input);
  }
}
