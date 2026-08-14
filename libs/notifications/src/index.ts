/**
 * @loan/notifications — provider-agnostic email + SMS dispatch.
 *
 * Providers implement `NotificationProvider`. Three exist:
 *
 *   - `MockNotificationProvider` — the dev/test default. Records the
 *     dispatch, sends nothing.
 *   - `SendGridProvider` (EMAIL) — `sendgrid.ts`.
 *   - `TwilioProvider` (SMS) — `twilio.ts`.
 *
 * The two real ones are plain `fetch` against a single documented endpoint
 * each, with no vendor SDK; `http.ts` carries that argument, the shared
 * timeout, and the rule that no error message may echo a request.
 *
 * Neither has run against a live account. They are constructible,
 * unit-tested for request shape and wired into both the platform factory
 * (`apps/api/src/providers.ts`) and the per-tenant resolver
 * (`apps/api/src/features/system/notification-providers.ts`), so turning
 * one on is a credential change rather than a development project — the
 * same standing the S3 adapter in `@loan/storage` shipped with.
 *
 * Templates live here as plain functions so they're easy to test.
 * `NotificationRepository` in @loan/db wires templates + providers together
 * and persists each send as a `Notification` row, marking it FAILED rather
 * than throwing when a provider errors.
 */

export {
  DEFAULT_TIMEOUT_MS,
  NotificationDeliveryError,
  postJson,
  type PostOptions,
  type ProviderRequest,
} from "./http";
export { SendGridProvider, type SendGridProviderOptions } from "./sendgrid";
export { TwilioProvider, type TwilioProviderOptions } from "./twilio";

export type Channel = "EMAIL" | "SMS" | "IN_APP";

export type NotificationEvent =
  | "LOAN_APPROVED"
  | "LOAN_REJECTED"
  | "LOAN_DISBURSED"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_DUE_SOON"
  | "PAYMENT_OVERDUE"
  | "PROMISE_TO_PAY"
  | "WELCOME"
  | "TEST"
  | "ANNUAL_DOC_EXPIRING"
  | "ANNUAL_DOC_EXPIRED"
  | "DEMAND_LETTER_DISPATCHED"
  | "LEASE_END_OF_TERM"
  | "LEASE_MAINTENANCE_REMINDER"
  | "LEASE_PULL_OUT_WARNING"
  | "CO_MAKER_INVITED"
  | "PASSWORD_RESET"
  | "LOAN_APPROVAL_PENDING"
  | "STATEMENT_READY"
  | "DELEGATION_REVOKED"
  | "USER_ROLE_CHANGED";

export interface SendInput {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
}

export interface SendResult {
  /** Provider's reference id, if any. */
  providerRef?: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channels: ReadonlySet<Channel>;
  send(input: SendInput): Promise<SendResult>;
}

/**
 * Redact a recipient down to something a developer can correlate but a log
 * reader cannot contact: first character, masked middle, and the email
 * domain (which is not personally identifying and is often the useful part
 * when a template goes to the wrong audience).
 *
 *   juan.delacruz@example.com -> j***@example.com
 *   +639171234567             -> +6391****567
 */
export function maskRecipient(recipient: string): string {
  const at = recipient.indexOf("@");
  if (at > 0) return `${recipient[0]!}***${recipient.slice(at)}`;
  if (recipient.length <= 7) return "***";
  return `${recipient.slice(0, 5)}****${recipient.slice(-3)}`;
}

/**
 * Default provider for dev/test. The dispatcher still records the
 * `Notification` row, so the UI sees the send happen.
 *
 * It deliberately does NOT log the recipient or the body.
 *
 * It used to `console.log` both, and that was a live privacy leak rather
 * than a dev convenience. Three things compounded:
 *
 *   1. Every provider path terminated here. `buildTenantTwilioProvider` and
 *      `buildTenantSendgridProvider` discarded their config and returned a
 *      mock, so configuring real credentials did not route around this.
 *      Real adapters now exist (`sendgrid.ts`, `twilio.ts`) and are wired,
 *      but this remains the default in dev and test — which is where
 *      developers actually read stdout — so the rule below still governs.
 *      It governs those adapters too: neither logs at all, and their errors
 *      carry a provider name and an HTTP status, never a request.
 *   2. `console.log` bypasses pino, so none of the `redact` paths in
 *      `app.ts` applied. Redaction that the data never passes through is
 *      not redaction.
 *   3. The bodies carry borrower name, outstanding balance and due date
 *      (PAYMENT_DUE_SOON / PAYMENT_OVERDUE), password-reset links, and
 *      co-maker consent tokens. A reset link in a log file is a live
 *      credential.
 *
 * §57 is explicit — "Never leak sensitive financial or PII data into logs"
 * — and §71 governs the PII. The masked recipient is enough to tell which
 * message went where; the body belongs in the `Notification` row, which is
 * access-controlled, not on stdout.
 */
export class MockNotificationProvider implements NotificationProvider {
  readonly name = "MOCK";
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);

  async send(input: SendInput): Promise<SendResult> {
    const ref = `mock-${Date.now()}`;
    // Length, not content: enough to spot an empty or truncated template
    // without reproducing what it said.
    console.log(
      `[notify:${input.channel}] → ${maskRecipient(input.recipient)} ` +
        `(${String(input.body.length)} chars, ref ${ref})`,
    );
    return { providerRef: ref };
  }
}

// ─── Templates ──────────────────────────────────────────────────────────

export interface RenderInput {
  event: NotificationEvent;
  channel: Channel;
  data: TemplateData;
}

export interface TemplateData {
  customerName?: string;
  loanNumber?: string;
  amount?: number;
  /** Locale-formatted date for due-soon / overdue. */
  dueDate?: string;
  /** Days overdue, where applicable. */
  daysOverdue?: number;
  /** Free-form reason for rejection / promise note / etc. */
  note?: string;
  /** Anything else; available to templates as %{key}%. */
  [k: string]: string | number | undefined;
}

export interface RenderedMessage {
  subject?: string;
  body: string;
}

/**
 * Render an event + channel into a subject/body pair. Templates are
 * intentionally terse and use a tiny `%{key}%` placeholder syntax so they're
 * easy to localize/customize per-deploy. Real systems would store these in
 * a DB table; we ship code-defined ones for now.
 */
export function renderTemplate(input: RenderInput): RenderedMessage {
  // The replacer's capture groups arrive as `any`; naming `k` as a string
  // keeps the `input.data` lookup type-checked.
  const sub = (s: string) =>
    s.replace(/%\{(\w+)\}%/g, (_, k: string) => String(input.data[k] ?? ""));
  const t = TEMPLATES[input.event];
  if (!t) return { body: `${input.event} (no template)` };
  return {
    subject:
      input.channel === "EMAIL" && t.subject ? sub(t.subject) : undefined,
    body: sub(t.body),
  };
}

const TEMPLATES: Record<NotificationEvent, { subject?: string; body: string }> =
  {
    LOAN_APPROVED: {
      subject: "Your loan %{loanNumber}% has been approved",
      body: "Hi %{customerName}%, good news — your loan %{loanNumber}% for %{amount}% has been approved. We will reach out to coordinate disbursement.",
    },
    LOAN_REJECTED: {
      subject: "Update on your loan application",
      body: "Hi %{customerName}%, your loan %{loanNumber}% was not approved. Reason: %{note}%. You can reapply after 30 days.",
    },
    LOAN_DISBURSED: {
      subject: "Funds disbursed: %{loanNumber}%",
      body: "Hi %{customerName}%, %{amount}% has been disbursed for loan %{loanNumber}%. Your first payment is due %{dueDate}%.",
    },
    PAYMENT_RECEIVED: {
      subject: "Payment received: %{loanNumber}%",
      body: "Hi %{customerName}%, we received your payment of %{amount}% on loan %{loanNumber}%. Thank you.",
    },
    PAYMENT_DUE_SOON: {
      subject: "Payment due %{dueDate}%",
      body: "Hi %{customerName}%, your next payment of %{amount}% on loan %{loanNumber}% is due %{dueDate}%.",
    },
    PAYMENT_OVERDUE: {
      subject: "Payment overdue: %{loanNumber}%",
      body: "Hi %{customerName}%, your payment of %{amount}% on loan %{loanNumber}% is %{daysOverdue}% day(s) overdue. Please settle to avoid additional fees.",
    },
    PROMISE_TO_PAY: {
      subject: "Promise to pay recorded",
      body: "Hi %{customerName}%, we have recorded your promise to pay %{amount}% on %{dueDate}% for loan %{loanNumber}%.",
    },
    PASSWORD_RESET: {
      subject: "Reset your %{companyName}% password",
      // No name in the body: the address may not belong to whoever
      // asked, and greeting a stranger by name confirms the account
      // exists to someone who only guessed the email.
      body: "A password reset was requested for this address. Open %{url}% to choose a new password — the link works once and expires in %{expiresIn}%. If this wasn't you, ignore this message and nothing changes.",
    },
    CO_MAKER_INVITED: {
      subject: "%{borrowerName}% named you as a %{roleLabel}%",
      // Deliberately short: this goes out by SMS first, and the link
      // has to survive being read on a feature phone. Says who, how
      // much, and that agreeing carries liability — everything else is
      // on the page behind the link.
      body: "Hi %{coMakerName}%, %{borrowerName}% named you as %{roleLabel}% on a %{amountLabel}% loan with %{companyName}%. Agreeing makes you jointly liable. Review and respond: %{url}%",
    },
    WELCOME: {
      subject: "Welcome to SmartLoan",
      body: "Hi %{customerName}%, welcome to SmartLoan. Your account is ready.",
    },
    TEST: {
      subject: "Test notification",
      body: "This is a test from SmartLoan. %{note}%",
    },
    ANNUAL_DOC_EXPIRING: {
      subject: "%{docType}% expires in %{daysOut}% days",
      body: "Hi %{customerName}%, your %{docName}% (%{docType}%) for loan %{loanNumber}% expires on %{expiresAt}% — %{daysOut}% day(s) away. Please submit a renewal to keep your account in good standing.",
    },
    ANNUAL_DOC_EXPIRED: {
      subject: "ACTION REQUIRED — %{docType}% expired",
      body: "Hi %{customerName}%, your %{docName}% (%{docType}%) for loan %{loanNumber}% expired on %{expiresAt}% (%{daysOut}% day(s) ago). Please submit a renewal immediately — continued non-compliance may trigger penalties or repossession.",
    },
    DEMAND_LETTER_DISPATCHED: {
      subject: "%{stageLabel}% — Loan %{loanNumber}%",
      body: "Hi %{customerName}%, a %{stageLabel}% has been issued on loan %{loanNumber}%. Total amount due: %{totalOwed}%. Please settle by %{paymentDeadline}% to avoid further escalation.",
    },
    LEASE_END_OF_TERM: {
      subject: "Lease end-of-term — Loan %{loanNumber}%",
      body: "Hi %{customerName}%, your lease on loan %{loanNumber}% ends in 60 days. Your options: (1) pay the residual buyout (%{residualValue}%) to take title, (2) return the vehicle, or (3) extend the lease. Please contact us to confirm your choice.",
    },
    LEASE_MAINTENANCE_REMINDER: {
      subject: "6-month maintenance reminder",
      body: "Hi %{customerName}%, this is a friendly reminder that your leased vehicle on loan %{loanNumber}% is due for periodic maintenance. Please coordinate with your preferred service center within the next two weeks.",
    },
    LEASE_PULL_OUT_WARNING: {
      subject: "URGENT — possible vehicle pull-out",
      body: "Hi %{customerName}%, your lease on loan %{loanNumber}% is %{missedCount}% missed payment(s) past due. Per the lease agreement, %{threshold}% consecutive misses trigger vehicle recovery. Please settle the outstanding amount immediately or contact us to discuss arrangements.",
    },
    // Sent to each authorized approver when a loan enters their step. The
    // body is written approver-facing (vs all the other borrower-facing
    // templates above) — staff get the loan number + borrower context so
    // they can act without context-switching from the notification.
    LOAN_APPROVAL_PENDING: {
      subject: "Approval needed: %{loanNumber}% (%{stepLabel}%)",
      body: "Hi %{recipientName}%, loan %{loanNumber}% for %{borrowerName}% (%{amount}%) is waiting on your approval at the “%{stepLabel}%” step. Open the loan to review and approve or reject.",
    },
    // Sent to the customer when their operator generates a statement of
    // account and asks the system to notify them. Body intentionally omits
    // amounts — the PDF carries the figures; this is just a "log in to
    // download" nudge so we don't email PII directly.
    STATEMENT_READY: {
      subject: "Your statement of account is ready",
      body: "Hi %{customerName}%, your statement of account dated %{asOf}% is ready to view. Log in to your portal to view and download it. If you have any questions about the figures, reply to this email or contact your loan officer.",
    },
    // Sent to the delegate when a delegation they hold is revoked
    // early (before its scheduled endsAt). The delegator's name + the
    // optional reason help the delegate understand why; a short
    // message is best because the same payload goes to SMS too.
    DELEGATION_REVOKED: {
      subject: "Delegation revoked",
      body: "Hi %{delegateName}%, the delegation from %{delegatorName}% was revoked%{reasonSuffix}%. Any work you were doing under that authority needs to be re-routed.",
    },
    // Sent to a user when their role assignments change. `change` is
    // either "added" or "removed"; `roleName` is the human-readable
    // role name. Recipient-facing; the actor's identity isn't named
    // here to keep the message neutral if the change is e.g. a
    // bulk-onboarding promotion.
    USER_ROLE_CHANGED: {
      subject: "Your access changed: %{roleName}%",
      body: "Hi %{recipientName}%, the %{roleName}% role was %{change}% on your account. Your effective permissions are updated immediately. If this looks wrong, contact your administrator.",
    },
  };
