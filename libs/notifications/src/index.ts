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

export type Channel = 'EMAIL' | 'SMS' | 'IN_APP';

export type NotificationEvent =
  | 'LOAN_APPROVED'
  | 'LOAN_REJECTED'
  | 'LOAN_DISBURSED'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_DUE_SOON'
  | 'PAYMENT_OVERDUE'
  | 'PROMISE_TO_PAY'
  | 'WELCOME'
  | 'TEST';

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
  readonly name = 'MOCK';
  readonly channels: ReadonlySet<Channel> = new Set(['EMAIL', 'SMS', 'IN_APP']);

  async send(input: SendInput): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(
      `[notify:${input.channel}] → ${input.recipient}: ${input.subject ?? ''}\n${input.body}`,
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
  const sub = (s: string) =>
    s.replace(/%\{(\w+)\}%/g, (_, k) => String(input.data[k] ?? ''));
  const t = TEMPLATES[input.event];
  if (!t) return { body: `${input.event} (no template)` };
  return {
    subject: input.channel === 'EMAIL' && t.subject ? sub(t.subject) : undefined,
    body: sub(t.body),
  };
}

const TEMPLATES: Record<
  NotificationEvent,
  { subject?: string; body: string }
> = {
  LOAN_APPROVED: {
    subject: 'Your loan %{loanNumber}% has been approved',
    body:
      'Hi %{customerName}%, good news — your loan %{loanNumber}% for %{amount}% has been approved. We will reach out to coordinate disbursement.',
  },
  LOAN_REJECTED: {
    subject: 'Update on your loan application',
    body:
      'Hi %{customerName}%, your loan %{loanNumber}% was not approved. Reason: %{note}%. You can reapply after 30 days.',
  },
  LOAN_DISBURSED: {
    subject: 'Funds disbursed: %{loanNumber}%',
    body:
      'Hi %{customerName}%, %{amount}% has been disbursed for loan %{loanNumber}%. Your first payment is due %{dueDate}%.',
  },
  PAYMENT_RECEIVED: {
    subject: 'Payment received: %{loanNumber}%',
    body:
      'Hi %{customerName}%, we received your payment of %{amount}% on loan %{loanNumber}%. Thank you.',
  },
  PAYMENT_DUE_SOON: {
    subject: 'Payment due %{dueDate}%',
    body:
      'Hi %{customerName}%, your next payment of %{amount}% on loan %{loanNumber}% is due %{dueDate}%.',
  },
  PAYMENT_OVERDUE: {
    subject: 'Payment overdue: %{loanNumber}%',
    body:
      'Hi %{customerName}%, your payment of %{amount}% on loan %{loanNumber}% is %{daysOverdue}% day(s) overdue. Please settle to avoid additional fees.',
  },
  PROMISE_TO_PAY: {
    subject: 'Promise to pay recorded',
    body:
      'Hi %{customerName}%, we have recorded your promise to pay %{amount}% on %{dueDate}% for loan %{loanNumber}%.',
  },
  WELCOME: {
    subject: 'Welcome to SmartLoan',
    body: 'Hi %{customerName}%, welcome to SmartLoan. Your account is ready.',
  },
  TEST: {
    subject: 'Test notification',
    body: 'This is a test from SmartLoan. %{note}%',
  },
};
