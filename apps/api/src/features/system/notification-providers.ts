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
 * ## Design: a provider per send, not per tenant
 *
 * The builders below construct a `TwilioProvider` /
 * `SendGridProvider` on each dispatch rather than caching one per
 * tenant. Both are stateless value objects over a `fetch` — no
 * socket pool, no handshake, no client to warm — so construction is
 * an object literal, and caching them would reintroduce exactly the
 * invalidation problem the per-call SystemConfig read exists to
 * avoid.
 *
 * ## Today's reality
 *
 * The real adapters now exist in `@loan/notifications`
 * (`sendgrid.ts`, `twilio.ts`) and the builders below construct
 * them from the tenant's own credentials. Neither has been run
 * against a live account — see the header of each adapter.
 */

import type {
  NotificationProvider,
  SendInput,
  SendResult,
  Channel,
} from "@loan/notifications";
import { SendGridProvider, TwilioProvider } from "@loan/notifications";
import type { PrismaClient } from "@loan/db";

/** Injection seam for tests; nothing in production passes these. */
export interface TenantProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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
 * When a tenant has Twilio creds configured, the SMS branch builds a
 * real `TwilioProvider` over those credentials; likewise SendGrid
 * for EMAIL. Anything else — IN_APP, or a channel whose credentials
 * are absent or partial — goes to the platform-shared fallback.
 */
export class TenantAwareNotificationProvider implements NotificationProvider {
  readonly name = "tenant-aware";
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fallback: NotificationProvider,
    private readonly opts: TenantProviderOptions = {},
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
      return buildTenantTwilioProvider(cfg, this.opts);
    }
    if (channel === "EMAIL" && hasSendgrid(cfg)) {
      return buildTenantSendgridProvider(cfg, this.opts);
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
// Real adapters over the tenant's own credentials. The `name` each
// carries — `twilio (tenant)` / `sendgrid (tenant)` — is what lands
// in error messages and lets an operator reading a FAILED
// Notification row tell a tenant-credential problem from a
// platform-credential one. That attribution was the only genuinely
// useful thing the old tagged mock did, so it is kept.

function buildTenantTwilioProvider(
  cfg: {
    twilioAccountSid: string;
    twilioAuthToken: string;
    twilioFromNumber: string;
  },
  opts: TenantProviderOptions = {},
): NotificationProvider {
  return new TwilioProvider({
    accountSid: cfg.twilioAccountSid,
    authToken: cfg.twilioAuthToken,
    fromNumber: cfg.twilioFromNumber,
    name: "twilio (tenant)",
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

function buildTenantSendgridProvider(
  cfg: {
    sendgridApiKey: string;
    sendgridFromEmail: string;
    sendgridFromName?: string | null;
  },
  opts: TenantProviderOptions = {},
): NotificationProvider {
  return new SendGridProvider({
    apiKey: cfg.sendgridApiKey,
    fromEmail: cfg.sendgridFromEmail,
    fromName: cfg.sendgridFromName,
    name: "sendgrid (tenant)",
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}
