/**
 * Twilio Programmable Messaging adapter (SMS).
 *
 * **Not exercised against the live API anywhere in this repo.** Same
 * standing as the SendGrid adapter next door and as the S3 adapter in
 * `@loan/storage`: constructible, unit-tested for request shape, wired into
 * the factory and the per-tenant resolver, never round-tripped against a
 * real account.
 *
 * The request, per Twilio's documented Messages resource:
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(AccountSid:AuthToken)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   To=%2B639171234567&From=%2B15551234567&Body=...
 *
 * A success is `201 Created` with a JSON body whose `sid` (an `SM…`
 * identifier) is the provider reference.
 *
 * Note the endpoint is form-encoded, not JSON — Twilio's REST API predates
 * the convention and still requires it. `URLSearchParams` does the encoding,
 * which matters for the `+` in an E.164 number: unencoded it decodes as a
 * space and the send fails with a confusing "not a valid phone number".
 *
 * ## What is deliberately missing
 *
 * Status callbacks (`StatusCallback`), which is the honest gap. Twilio's
 * 201 means *accepted for delivery*, not delivered — a number that is off,
 * unreachable or a landline fails asynchronously and this adapter will have
 * already recorded `SENT`. Closing that needs a public webhook endpoint and
 * a `Notification` status beyond the three the schema has today
 * (QUEUED/SENT/FAILED), so it is a separate change against the schema this
 * branch does not own. Until then `SENT` should be read as "Twilio accepted
 * it", and Twilio's own console is the delivery record.
 *
 * Also absent: `MessagingServiceSid` (the alternative to a from-number, for
 * number pools and sender-id routing), media/MMS, and scheduled sends.
 */

import { postJson, type ProviderRequest } from "./http";
import type { Channel, NotificationProvider, SendInput, SendResult } from ".";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioProviderOptions {
  accountSid: string;
  authToken: string;
  /** E.164 sender, e.g. `+15551234567`. */
  fromNumber: string;
  /** Per-request ceiling. See http.ts for why this exists. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Label recorded on the Notification row. Lets the tenant path tag itself. */
  name?: string;
}

export class TwilioProvider implements NotificationProvider {
  readonly name: string;
  /**
   * SMS only. Twilio does sell an email product (SendGrid, which it owns),
   * but this adapter speaks the Messages API; claiming EMAIL would route
   * mail into an SMS endpoint.
   */
  readonly channels: ReadonlySet<Channel> = new Set<Channel>(["SMS"]);

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly timeoutMs?: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: TwilioProviderOptions) {
    if (!opts.accountSid) {
      throw new Error("TwilioProvider requires an accountSid");
    }
    if (!opts.authToken)
      throw new Error("TwilioProvider requires an authToken");
    if (!opts.fromNumber) {
      throw new Error("TwilioProvider requires a fromNumber");
    }
    this.name = opts.name ?? "TWILIO";
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fromNumber = opts.fromNumber;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Build the exact request that `send` would issue. Separated from `send`
   * so the tests can pin it without a fetch.
   */
  buildRequest(input: SendInput): ProviderRequest {
    // The account SID is path data. It is ours, not user input, but
    // encoding it costs nothing and keeps a malformed value from
    // reshaping the URL.
    const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(
      this.accountSid,
    )}/Messages.json`;

    const form = new URLSearchParams();
    form.set("To", input.recipient);
    form.set("From", this.fromNumber);
    form.set("Body", input.body);

    return {
      url,
      headers: {
        authorization: `Basic ${basicAuth(this.accountSid, this.authToken)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.channel !== "SMS") {
      throw new Error(
        `TwilioProvider cannot send channel ${input.channel}; SMS only`,
      );
    }

    const res = await postJson({
      provider: this.name,
      request: this.buildRequest(input),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    // The message was accepted either way; a body we cannot parse costs us
    // the reference, not the send. Recording SENT with no providerRef is
    // strictly better than a FAILED row for a message Twilio has.
    const sid = await res
      .json()
      .then((b: unknown) => (b as { sid?: string } | null)?.sid)
      .catch(() => undefined);

    return sid ? { providerRef: sid } : {};
  }
}

/** HTTP Basic credentials. The one piece of "auth algorithm" involved. */
function basicAuth(user: string, pass: string): string {
  return Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}
