/**
 * Twilio adapter — the request it would send, against an injected fetch.
 * No network, no account SID, no phone number.
 *
 * Pinned to Twilio's documented Messages resource: the
 * `/2010-04-01/Accounts/{Sid}/Messages.json` path, HTTP Basic, form
 * encoding, and the `To` / `From` / `Body` parameters.
 */

import { describe, expect, it, vi } from "vitest";

import type { NotificationDeliveryError } from "./http";
import { TwilioProvider } from "./twilio";
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

const SID = "AC00000000000000000000000000000001";

function makeProvider(
  fetchImpl?: ReturnType<typeof fakeFetch>,
  extra: Partial<ConstructorParameters<typeof TwilioProvider>[0]> = {},
) {
  return new TwilioProvider({
    accountSid: SID,
    authToken: "test-auth-token",
    fromNumber: "+15551234567",
    fetchImpl,
    ...extra,
  });
}

const SMS: SendInput = {
  channel: "SMS",
  recipient: "+639171234567",
  body: "Hi Juan, your payment of 12,345.67 is 3 days overdue.",
};

describe("request shape", () => {
  it("POSTs to the account's Messages.json resource", async () => {
    const f = fakeFetch({ status: 201 });
    await makeProvider(f).send(SMS);

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("authenticates with HTTP Basic over sid:token", () => {
    const { headers } = makeProvider().buildRequest(SMS);
    const auth = headers.authorization ?? "";
    expect(auth).toBe(
      `Basic ${Buffer.from(`${SID}:test-auth-token`, "utf8").toString("base64")}`,
    );
    // Decodable back to the documented pair — a guard on the separator.
    const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe(`${SID}:test-auth-token`);
  });

  it("form-encodes To / From / Body", () => {
    const { body } = makeProvider().buildRequest(SMS);
    const parsed = new URLSearchParams(body);
    expect(parsed.get("To")).toBe("+639171234567");
    expect(parsed.get("From")).toBe("+15551234567");
    expect(parsed.get("Body")).toBe(
      "Hi Juan, your payment of 12,345.67 is 3 days overdue.",
    );
  });

  /*
   * The specific bug this guards. In form encoding a raw `+` decodes as a
   * space, so an unencoded E.164 number arrives at Twilio as
   * " 639171234567" and fails as "not a valid phone number" — a confusing
   * error a long way from its cause.
   */
  it("percent-encodes the leading + of an E.164 number", () => {
    const { body } = makeProvider().buildRequest(SMS);
    expect(body).toContain("To=%2B639171234567");
    expect(body).toContain("From=%2B15551234567");
  });

  it("encodes a body containing ampersands and newlines without splitting fields", () => {
    const { body } = makeProvider().buildRequest({
      ...SMS,
      body: "A&B\nsecond line=x",
    });
    expect(new URLSearchParams(body).get("Body")).toBe("A&B\nsecond line=x");
    expect(new URLSearchParams(body).get("To")).toBe("+639171234567");
  });
});

describe("construction", () => {
  it("declares SMS and only SMS", () => {
    expect([...makeProvider().channels]).toEqual(["SMS"]);
  });

  it("refuses to send a channel it does not own", async () => {
    const f = fakeFetch({ status: 201 });
    await expect(
      makeProvider(f).send({ ...SMS, channel: "EMAIL" }),
    ).rejects.toThrow(/SMS only/);
    expect(f).not.toHaveBeenCalled();
  });

  it("requires all three credentials", () => {
    const base = { accountSid: SID, authToken: "t", fromNumber: "+1" };
    expect(() => new TwilioProvider({ ...base, accountSid: "" })).toThrow(
      /accountSid/,
    );
    expect(() => new TwilioProvider({ ...base, authToken: "" })).toThrow(
      /authToken/,
    );
    expect(() => new TwilioProvider({ ...base, fromNumber: "" })).toThrow(
      /fromNumber/,
    );
  });
});

describe("results and failures", () => {
  it("takes the provider reference from the response sid", async () => {
    const f = fakeFetch({
      status: 201,
      json: async () => ({ sid: "SM0123456789abcdef", status: "queued" }),
    });
    expect(await makeProvider(f).send(SMS)).toEqual({
      providerRef: "SM0123456789abcdef",
    });
  });

  it("keeps the send successful when the response body cannot be parsed", async () => {
    const f = fakeFetch({
      status: 201,
      json: async () => {
        throw new Error("not json");
      },
    });
    // Twilio has the message; losing the reference must not manufacture a
    // FAILED row for a message that was accepted.
    expect(await makeProvider(f).send(SMS)).toEqual({});
  });

  it("surfaces the status and Twilio's own error text", async () => {
    const f = fakeFetch({
      status: 400,
      text: async () =>
        '{"code":21211,"message":"Invalid \'To\' Phone Number"}',
    });
    await expect(makeProvider(f).send(SMS)).rejects.toThrow(/HTTP 400.*21211/);
  });

  it("never puts the request, the recipient or the auth token in the error", async () => {
    const f = fakeFetch({ status: 401, text: async () => "Authenticate" });
    const err = await makeProvider(f)
      .send(SMS)
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
    expect(exposed).not.toContain("+639171234567");
    expect(exposed).not.toContain("12,345.67");
    expect(exposed).not.toContain("Juan");
    expect(exposed).not.toContain("test-auth-token");
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
    await expect(
      makeProvider(slow, { timeoutMs: 5 }).send(SMS),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it("reports a transport failure without inventing a status", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(makeProvider(f).send(SMS)).rejects.toThrow(
      /transport error: ECONNREFUSED/,
    );
  });
});
