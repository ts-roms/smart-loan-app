/**
 * SendGrid adapter — the request it would send, against an injected fetch.
 * No network, no API key, no account.
 *
 * These assertions are pinned to SendGrid's documented v3 mail-send format
 * rather than to the implementation: URL, method, auth header shape, and
 * the `personalizations` / `from` / `subject` / `content` body. Same role
 * as the published-vector test in `@loan/storage`'s sigv4 — the request is
 * fully determined by the inputs, so a fixture proves it without a live
 * endpoint.
 */

import { describe, expect, it, vi } from "vitest";

import { NotificationDeliveryError } from "./http";
import { SendGridProvider } from "./sendgrid";
import type { SendInput } from "./index";

function fakeFetch(res: Partial<Response> & { status: number }) {
  return vi.fn().mockResolvedValue({
    ok: res.status >= 200 && res.status < 300,
    statusText: "",
    headers: new Headers(),
    text: async () => "",
    json: async () => ({}),
    ...res,
  });
}

function makeProvider(
  fetchImpl?: ReturnType<typeof fakeFetch>,
  extra: Partial<ConstructorParameters<typeof SendGridProvider>[0]> = {},
) {
  return new SendGridProvider({
    apiKey: "SG.test-key",
    fromEmail: "noreply@acme-coop.com",
    fetchImpl,
    ...extra,
  });
}

const EMAIL: SendInput = {
  channel: "EMAIL",
  recipient: "borrower@example.com",
  subject: "Payment due 2026-09-01",
  body: "Hi Juan, your next payment of 12,345.67 is due.",
};

describe("request shape", () => {
  it("POSTs to the documented v3 endpoint with a bearer key", async () => {
    const f = fakeFetch({ status: 202 });
    await makeProvider(f).send(EMAIL);

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer SG.test-key");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("builds the personalizations / from / subject / content body", () => {
    const req = makeProvider().buildRequest(EMAIL);
    expect(JSON.parse(req.body)).toEqual({
      personalizations: [{ to: [{ email: "borrower@example.com" }] }],
      from: { email: "noreply@acme-coop.com" },
      subject: "Payment due 2026-09-01",
      content: [
        {
          type: "text/plain",
          value: "Hi Juan, your next payment of 12,345.67 is due.",
        },
      ],
    });
  });

  it("includes a display name on `from` only when one is configured", () => {
    const withName = makeProvider(undefined, { fromName: "Acme Coop" });
    expect(
      (JSON.parse(withName.buildRequest(EMAIL).body) as { from: unknown }).from,
    ).toEqual({ email: "noreply@acme-coop.com", name: "Acme Coop" });

    // Absent, not null/empty: SendGrid rejects `name: null`.
    expect(
      Object.keys(
        (
          JSON.parse(makeProvider().buildRequest(EMAIL).body) as {
            from: object;
          }
        ).from,
      ),
    ).toEqual(["email"]);
  });

  it("substitutes a subject rather than sending none — SendGrid rejects that", () => {
    const req = makeProvider().buildRequest({ ...EMAIL, subject: undefined });
    expect((JSON.parse(req.body) as { subject: string }).subject).toBe(
      "Notification",
    );
  });

  it("sends text/plain, so a borrower's name is never markup", () => {
    const req = makeProvider().buildRequest({
      ...EMAIL,
      body: "Hi <script>alert(1)</script> & co",
    });
    const parsed = JSON.parse(req.body) as {
      content: Array<{ type: string; value: string }>;
    };
    expect(parsed.content[0]!.type).toBe("text/plain");
    expect(parsed.content[0]!.value).toBe("Hi <script>alert(1)</script> & co");
  });
});

describe("construction", () => {
  it("declares EMAIL and only EMAIL", () => {
    expect([...makeProvider().channels]).toEqual(["EMAIL"]);
  });

  it("refuses to send a channel it does not own", async () => {
    const f = fakeFetch({ status: 202 });
    await expect(
      makeProvider(f).send({ ...EMAIL, channel: "SMS" }),
    ).rejects.toThrow(/EMAIL only/);
    // Failed at the seam, not at the API.
    expect(f).not.toHaveBeenCalled();
  });

  it("requires an api key and a from address", () => {
    expect(
      () => new SendGridProvider({ apiKey: "", fromEmail: "a@b.c" }),
    ).toThrow(/apiKey/);
    expect(
      () => new SendGridProvider({ apiKey: "SG.x", fromEmail: "" }),
    ).toThrow(/fromEmail/);
  });
});

describe("results and failures", () => {
  it("takes the provider reference from the X-Message-Id header", async () => {
    const f = fakeFetch({
      status: 202,
      headers: new Headers({ "x-message-id": "msg-abc123" }),
    });
    expect(await makeProvider(f).send(EMAIL)).toEqual({
      providerRef: "msg-abc123",
    });
  });

  it("still reports success when the id header is absent", async () => {
    const f = fakeFetch({ status: 202 });
    expect(await makeProvider(f).send(EMAIL)).toEqual({});
  });

  it("surfaces the status and the provider's own error text", async () => {
    const f = fakeFetch({
      status: 401,
      text: async () =>
        '{"errors":[{"message":"The provided authorization grant is invalid"}]}',
    });
    await expect(makeProvider(f).send(EMAIL)).rejects.toThrow(
      /HTTP 401.*authorization grant is invalid/,
    );
  });

  it("attaches the status to the error so an operator can triage a FAILED row", async () => {
    const f = fakeFetch({ status: 403, text: async () => "forbidden" });
    await expect(makeProvider(f).send(EMAIL)).rejects.toMatchObject({
      name: "NotificationDeliveryError",
      status: 403,
      provider: "SENDGRID",
    });
  });

  /*
   * The point of the whole error design. `NotificationRepository.dispatch`
   * writes `err.message` into `Notification.error`, and callers such as
   * `public.service.ts` pino-log the error object whole. Neither the body
   * nor the recipient nor the API key may reach either.
   */
  it("never puts the request, the recipient or the key in the error", async () => {
    const f = fakeFetch({ status: 400, text: async () => "Bad Request" });
    const err = await makeProvider(f)
      .send(EMAIL)
      .then(
        () => {
          throw new Error("expected the send to reject");
        },
        (e: unknown) => e as NotificationDeliveryError,
      );

    const exposed = JSON.stringify({
      message: err.message,
      ...Object.fromEntries(
        Object.getOwnPropertyNames(err).map((k) => [
          k,
          (err as unknown as Record<string, unknown>)[k],
        ]),
      ),
    });
    expect(exposed).not.toContain("borrower@example.com");
    expect(exposed).not.toContain("12,345.67");
    expect(exposed).not.toContain("Juan");
    expect(exposed).not.toContain("SG.test-key");
  });

  it("times out rather than hanging a caller that is mid-transaction", async () => {
    const slow = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("aborted"), { name: "TimeoutError" }),
            );
          });
        }),
    );
    const p = makeProvider(slow, { timeoutMs: 5 }).send(EMAIL);
    await expect(p).rejects.toThrow(/timed out after 5ms/);
  });
});
