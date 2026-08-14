/**
 * SendGrid v3 Mail Send adapter (EMAIL).
 *
 * **Not exercised against the live API anywhere in this repo.** It is
 * constructible, unit-tested for URL / auth / body shape, and wired into
 * both the platform factory and the per-tenant resolver, so switching a
 * deployment over is a matter of setting credentials. What it has not had
 * is a round-trip against a real SendGrid account — see "Before this can be
 * switched on" at the bottom.
 *
 * The request, per SendGrid's documented v3 format:
 *
 *   POST https://api.sendgrid.com/v3/mail/send
 *   Authorization: Bearer SG.xxxx
 *   Content-Type: application/json
 *
 *   { "personalizations": [ { "to": [ { "email": "..." } ] } ],
 *     "from": { "email": "...", "name": "..." },
 *     "subject": "...",
 *     "content": [ { "type": "text/plain", "value": "..." } ] }
 *
 * A success is `202 Accepted` with an empty body; the provider reference is
 * in the `X-Message-Id` response header, not the body.
 *
 * ## What is deliberately missing
 *
 * Dynamic templates, attachments, categories, scheduled sends, and the
 * sandbox flag. Templates already live in `renderTemplate` here, in code
 * that is unit-tested and reviewed in this repo — moving them into
 * SendGrid's dashboard would split the message catalogue across two systems
 * and make a template change an untracked, unreviewed production edit.
 *
 * `text/plain` rather than `text/html` for the same reason: every template
 * in `index.ts` is plain prose with no markup, and sending it as HTML would
 * mean escaping borrower names and amounts to avoid an injection into the
 * borrower's mail client. Plain text has no such failure mode.
 */

import { postJson, type ProviderRequest } from "./http";
import type { Channel, NotificationProvider, SendInput, SendResult } from ".";

const SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

export interface SendGridProviderOptions {
  apiKey: string;
  fromEmail: string;
  /** Display name on the From header. Optional; SendGrid defaults to the address. */
  fromName?: string | null;
  /** Per-request ceiling. See http.ts for why this exists. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Label recorded on the Notification row. Lets the tenant path tag itself. */
  name?: string;
}

/**
 * SendGrid rejects a send with no subject. Every EMAIL template in
 * `renderTemplate` supplies one, so this is a floor for the
 * `(no template)` fallback path rather than an expected case — but a
 * dropped notification is worse than a vague one.
 */
const FALLBACK_SUBJECT = "Notification";

export class SendGridProvider implements NotificationProvider {
  readonly name: string;
  /**
   * EMAIL only. SMS through SendGrid is not a thing, and claiming the
   * channel would let the tenant resolver or a future factory route an SMS
   * here and fail at the API instead of at the seam.
   */
  readonly channels: ReadonlySet<Channel> = new Set<Channel>(["EMAIL"]);

  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName?: string;
  private readonly timeoutMs?: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: SendGridProviderOptions) {
    if (!opts.apiKey) throw new Error("SendGridProvider requires an apiKey");
    if (!opts.fromEmail) {
      throw new Error("SendGridProvider requires a fromEmail");
    }
    this.name = opts.name ?? "SENDGRID";
    this.apiKey = opts.apiKey;
    this.fromEmail = opts.fromEmail;
    this.fromName = opts.fromName ?? undefined;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Build the exact request that `send` would issue.
   *
   * Separated from `send` so the tests can pin URL, method, auth header and
   * body without a fetch — the same reason `signRequest` in @loan/storage
   * returns its canonical request.
   */
  buildRequest(input: SendInput): ProviderRequest {
    const from: { email: string; name?: string } = { email: this.fromEmail };
    if (this.fromName) from.name = this.fromName;

    return {
      url: SENDGRID_MAIL_SEND_URL,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.recipient }] }],
        from,
        subject: input.subject || FALLBACK_SUBJECT,
        content: [{ type: "text/plain", value: input.body }],
      }),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.channel !== "EMAIL") {
      throw new Error(
        `SendGridProvider cannot send channel ${input.channel}; EMAIL only`,
      );
    }

    const res = await postJson({
      provider: this.name,
      request: this.buildRequest(input),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    // 202 with an empty body. The id is a header, and it is what SendGrid's
    // own Activity Feed and Event Webhook key on, so it is the only value
    // that makes the Notification row traceable back to a delivery.
    const ref = res.headers?.get?.("x-message-id");
    return ref ? { providerRef: ref } : {};
  }
}
