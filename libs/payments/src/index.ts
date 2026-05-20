/**
 * @loan/payments — provider-agnostic payment abstraction.
 *
 * The API talks to providers through `PaymentProvider`. The MockProvider
 * ships in this package so dev/test works without external creds; real
 * providers (GCash, Maya, Stripe, etc.) implement the same interface.
 *
 * Webhook handling lives in the API route — providers expose a verification
 * helper here so the route can confirm a callback really came from them.
 */

export type PaymentProviderName = 'MOCK' | 'GCASH' | 'MAYA';

// Re-declared inline below — `as const` ensures the discriminated union in
// the provider classes matches the enum.

export type PaymentIntentStatus =
  | 'CREATED'      // intent issued; waiting for the customer to pay
  | 'PROCESSING'   // provider acknowledged the customer initiated
  | 'PAID'         // funds confirmed
  | 'FAILED'       // customer cancelled or provider declined
  | 'EXPIRED';     // intent ttl passed

export interface CreateIntentInput {
  /** Internal id of the loan this payment is for (passed back via webhook). */
  loanId: string;
  amount: number;
  /** Free-form customer-facing description. */
  description?: string;
  /** Idempotency key so retries don't double-create the intent. */
  idempotencyKey: string;
  /** Where the provider should call back when the payment is done. */
  webhookUrl: string;
  /** Where the user is redirected after paying. */
  returnUrl?: string;
}

export interface CreatedIntent {
  /** Provider-side id (e.g. "ch_abc123"). */
  externalId: string;
  /** URL the customer opens to complete payment. */
  paymentUrl: string;
  status: PaymentIntentStatus;
}

export interface WebhookEvent {
  externalId: string;
  status: PaymentIntentStatus;
  /** Amount the provider actually saw (may differ from intent.amount). */
  amount?: number;
  /** Provider's own reference (e.g. bank OR number). */
  reference?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  /** Verify + normalize an incoming webhook payload. */
  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent;
}

/**
 * Dev/sandbox provider. Doesn't talk to any external service.
 *   - `createIntent` returns a deterministic external id + a "payment URL"
 *     pointing at the API's mock-confirm endpoint.
 *   - `parseWebhook` accepts the body as-is (no signature check).
 *
 * The actual "confirm" endpoint lives in the API; this just hands out the
 * URL and parses the resulting callback.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'MOCK' as const;

  constructor(private readonly opts: { baseUrl: string }) {}

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    const externalId = `mock_${input.idempotencyKey}`;
    // The sandbox URL is what an officer/customer hits to simulate paying.
    const paymentUrl = `${this.opts.baseUrl}/api/v1/payments/mock/confirm/${externalId}`;
    return { externalId, paymentUrl, status: 'CREATED' };
  }

  parseWebhook(_headers: Record<string, string>, body: unknown): WebhookEvent {
    const b = body as { externalId?: string; status?: PaymentIntentStatus; amount?: number; reference?: string };
    if (!b.externalId || !b.status) {
      throw new Error('Mock webhook missing externalId or status');
    }
    return { externalId: b.externalId, status: b.status, amount: b.amount, reference: b.reference, raw: body };
  }
}

// ─── Real-provider scaffolding ─────────────────────────────────────────
//
// The two real PH gateways we'd plug in. Both follow a similar pattern:
//   - createIntent → POST to checkout/payment endpoint, returns redirect URL
//   - parseWebhook → verify signature header, return normalized event
//
// We don't ship working HTTP calls because they need merchant credentials
// + a sandbox account. The skeleton makes swapping in real wiring a
// constructor-arg + ~30-line implementation change.

export interface GcashConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  /** Where the customer is redirected after paying. */
  successUrl: string;
}

export class GcashProvider implements PaymentProvider {
  readonly name = 'GCASH' as const;

  constructor(private readonly opts: GcashConfig) {
    if (!opts.apiKey) {
      throw new Error(
        'GCASH not configured — set GCASH_API_KEY + GCASH_WEBHOOK_SECRET',
      );
    }
  }

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    // Real call: POST `${baseUrl}/checkout` with the api key + idempotency key.
    // Response carries `id` and `checkoutUrl`. The shape below mirrors that
    // so the route doesn't care which provider is in use.
    throw new Error(
      `GcashProvider.createIntent not implemented for loan ${input.loanId}.`,
    );
  }

  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent {
    const sig = headers['x-gcash-signature'];
    if (!sig) throw new Error('Missing GCash signature');
    // Real call: HMAC-verify sig against opts.webhookSecret + raw body.
    void this.opts.webhookSecret;
    const b = body as {
      data?: { id?: string; status?: string; amount?: number; reference?: string };
    };
    if (!b.data?.id || !b.data.status) {
      throw new Error('Malformed GCash webhook');
    }
    return {
      externalId: b.data.id,
      status: mapGcashStatus(b.data.status),
      amount: b.data.amount,
      reference: b.data.reference,
      raw: body,
    };
  }
}

export interface MayaConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
}

export class MayaProvider implements PaymentProvider {
  readonly name = 'MAYA' as const;

  constructor(private readonly opts: MayaConfig) {
    if (!opts.secretKey) {
      throw new Error('MAYA not configured — set MAYA_SECRET_KEY');
    }
  }

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    throw new Error(
      `MayaProvider.createIntent not implemented for loan ${input.loanId}.`,
    );
  }

  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent {
    const sig = headers['paymongo-signature'] ?? headers['maya-signature'];
    if (!sig) throw new Error('Missing Maya signature');
    void this.opts.webhookSecret;
    const b = body as {
      data?: {
        attributes?: {
          external_id?: string;
          status?: string;
          amount?: number;
          metadata?: { reference?: string };
        };
      };
    };
    const attrs = b.data?.attributes;
    if (!attrs?.external_id || !attrs.status) {
      throw new Error('Malformed Maya webhook');
    }
    return {
      externalId: attrs.external_id,
      status: mapMayaStatus(attrs.status),
      amount: attrs.amount,
      reference: attrs.metadata?.reference,
      raw: body,
    };
  }
}

function mapGcashStatus(s: string): PaymentIntentStatus {
  switch (s.toUpperCase()) {
    case 'PAID':
    case 'COMPLETED':
    case 'SUCCESS':
      return 'PAID';
    case 'PROCESSING':
    case 'PENDING':
      return 'PROCESSING';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return 'CREATED';
  }
}

function mapMayaStatus(s: string): PaymentIntentStatus {
  switch (s.toLowerCase()) {
    case 'payment_paid':
    case 'paid':
      return 'PAID';
    case 'payment_processing':
    case 'awaiting_payment_method':
      return 'PROCESSING';
    case 'payment_expired':
      return 'EXPIRED';
    case 'payment_failed':
      return 'FAILED';
    default:
      return 'CREATED';
  }
}

/**
 * Factory: pick the provider based on env. Returns the MockProvider for any
 * unknown / unset value so dev keeps working without configuration.
 */
export function buildProvider(env: Record<string, string | undefined>, baseUrl: string): PaymentProvider {
  switch ((env.PAYMENT_PROVIDER ?? 'mock').toLowerCase()) {
    case 'gcash':
      return new GcashProvider({
        baseUrl: env.GCASH_BASE_URL ?? 'https://api.gcash.com',
        apiKey: env.GCASH_API_KEY ?? '',
        webhookSecret: env.GCASH_WEBHOOK_SECRET ?? '',
        successUrl: env.GCASH_SUCCESS_URL ?? `${baseUrl}/portal/loans`,
      });
    case 'maya':
      return new MayaProvider({
        baseUrl: env.MAYA_BASE_URL ?? 'https://api.maya.ph',
        publicKey: env.MAYA_PUBLIC_KEY ?? '',
        secretKey: env.MAYA_SECRET_KEY ?? '',
        webhookSecret: env.MAYA_WEBHOOK_SECRET ?? '',
        successUrl: env.MAYA_SUCCESS_URL ?? `${baseUrl}/portal/loans`,
      });
    default:
      return new MockProvider({ baseUrl });
  }
}
