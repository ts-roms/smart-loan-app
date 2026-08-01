/**
 * @loan/notifications — provider-agnostic email + SMS dispatch.
 *
 * Providers implement `NotificationProvider`. The shipped `MockProvider`
 * just logs to console and resolves; production swaps in SendGrid /
 * Postmark / SES (email) and Semaphore / Globe Labs / Twilio (SMS).
 *
 * Templates live here as plain functions so they're easy to test. The
 * NotificationDispatcher in @loan/db wires templates + providers together
 * and persists each send as a `Notification` row.
 */

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
 * Default provider for dev/test. Logs the message and returns. The dispatcher
 * still records the `Notification` row, so the UI sees the send happen.
 */
export class MockNotificationProvider implements NotificationProvider {
  readonly name = "MOCK";
  readonly channels: ReadonlySet<Channel> = new Set(["EMAIL", "SMS", "IN_APP"]);

  async send(input: SendInput): Promise<SendResult> {
    console.log(
      `[notify:${input.channel}] → ${input.recipient}: ${input.subject ?? ""}\n${input.body}`,
    );
    return { providerRef: `mock-${Date.now()}` };
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
