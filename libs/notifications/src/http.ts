/**
 * Shared HTTP transport for the real notification providers.
 *
 * ## Why not the vendor SDKs
 *
 * `@sendgrid/mail` and `twilio` are the obvious answers, and neither is in
 * `pnpm-lock.yaml` today — adding them is a new dependency decision, not a
 * version bump. `@loan/storage` made the same call for S3 and the reasoning
 * carries over more strongly here, because there is less to hand-roll:
 *
 *   - SigV4 at least had a signing algorithm to get right, which is why
 *     `sigv4.test.ts` pins it against AWS's published vectors. Neither
 *     provider here has one. SendGrid authenticates with
 *     `Authorization: Bearer <key>` and Twilio with HTTP Basic — both are
 *     one header, and Node builds Basic with `Buffer.toString("base64")`.
 *   - Each send is a single POST to a single documented endpoint. We use
 *     no templates, no scheduling, no attachments, no inbound parse, no
 *     status callbacks, no subaccount management — which is most of what
 *     the SDKs weigh.
 *   - `twilio` pulls a request stack and its own retry middleware;
 *     `@sendgrid/mail` pulls `@sendgrid/client` and its helper class tree.
 *     That is a supply-chain surface, in the dependency path of an app that
 *     moves money, for roughly sixty lines of `fetch`.
 *
 * The trade is real and it is the same one storage made: we own the request
 * shape, so a wrong field name is our bug. That is what `sendgrid.test.ts`
 * and `twilio.test.ts` are for — they pin URL, method, auth header shape and
 * body against the providers' documented formats, with an injected fetch, so
 * they prove the request without a network or credentials.
 *
 * ## Why there is a timeout
 *
 * §48 requires that notification delivery not block financial transactions.
 * Today that holds because every provider is a mock that resolves instantly.
 * It is not a property of the call sites: `loans.service.ts` awaits the
 * disbursement notification inside the HTTP request path, after the money
 * has already moved. A real provider socket that hangs would hang that
 * response.
 *
 * So the timeout lives here rather than at the call sites. It is the one
 * place that covers all of them, it cannot be forgotten by the next call
 * site added, and a timeout surfaces as a thrown error — which the
 * dispatcher already turns into a `FAILED` Notification row rather than an
 * exception thrown into a payment.
 *
 * ## Why the errors are so careful
 *
 * `NotificationRepository.dispatch` persists `err.message` into
 * `Notification.error`. Anything this file puts in a message is stored, and
 * may be logged by a caller that catches. So: never the request body, never
 * the recipient, never a credential. Provider response text is included
 * (truncated) because without it a bare 401 cannot be told from a bad
 * from-address, but it is the *response*, which we did not fill with
 * borrower data.
 *
 * Node 20+ is required for global `fetch` and `AbortSignal.timeout`, which
 * `engines` already pins (>=20.11.0).
 */

/** Default per-request ceiling. Overridable per provider. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of a provider's error response to keep. */
const MAX_DETAIL_CHARS = 300;

/**
 * A delivery failure, with the provider and HTTP status attached so an
 * operator reading a FAILED Notification row can tell a credential problem
 * from a malformed-recipient one.
 *
 * The message is assembled from the provider name, the status, and the
 * provider's own response text — never from the request.
 */
export class NotificationDeliveryError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(provider: string, message: string, status?: number) {
    super(`${provider} send failed: ${message}`);
    this.name = "NotificationDeliveryError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Read a failed response's body for diagnosis, truncated and flattened.
 *
 * Providers answer with JSON (`{"errors":[{"message":...}]}` for SendGrid,
 * `{"message":...,"code":...}` for Twilio) but not reliably — a gateway 502
 * in front of them returns HTML. Treating it as opaque text and truncating
 * handles both without a parse that can itself throw.
 */
async function errorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS
    ? `${flat.slice(0, MAX_DETAIL_CHARS)}…`
    : flat;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface PostOptions {
  /** Name used in error messages and the Notification row's provider column. */
  provider: string;
  request: ProviderRequest;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * POST a prepared request and return the response, converting a non-2xx,
 * an abort or a transport error into a `NotificationDeliveryError`.
 *
 * Callers build the request separately (see `sendgrid.ts` / `twilio.ts`) so
 * the tests can assert the exact bytes that would go on the wire without
 * standing up a fetch at all.
 */
export async function postJson(opts: PostOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  let res: Response;
  try {
    res = await doFetch(opts.request.url, {
      method: "POST",
      headers: opts.request.headers,
      body: opts.request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout arrives as an AbortError/TimeoutError. Name it explicitly:
    // "timed out after 10000ms" tells an operator to look at the network,
    // where a bare "The operation was aborted" does not.
    const cause = err as { name?: string; message?: string };
    const isTimeout =
      cause?.name === "TimeoutError" || cause?.name === "AbortError";
    throw new NotificationDeliveryError(
      opts.provider,
      isTimeout
        ? `timed out after ${String(timeoutMs)}ms`
        : // A transport error's message is about the connection
          // (DNS, TLS, ECONNREFUSED), not about what we sent.
          `transport error: ${cause?.message ?? "unknown"}`,
    );
  }

  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new NotificationDeliveryError(
      opts.provider,
      `HTTP ${String(res.status)}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }

  return res;
}
