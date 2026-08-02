/**
 * Payment providers — intent creation, webhook parsing, and the factory.
 *
 * A payment webhook is an instruction to credit money against a loan: the
 * route hands the parsed event to `handleWebhook`, which writes a
 * LoanPayment when the status is PAID. So the questions worth asking here
 * are about what gets *accepted*, not what gets parsed.
 *
 * Two defects were found writing these and are fixed alongside:
 *
 *   1. GcashProvider and MayaProvider checked only that a signature header
 *      was present, then discarded the secret. Any attacker-supplied value
 *      was accepted as a genuine callback. They now fail closed.
 *   2. buildProvider silently fell back to the signature-less MockProvider
 *      for any unrecognised PAYMENT_PROVIDER, so a typo turned a production
 *      payments endpoint into one that trusts anything. It now throws.
 */

import { describe, expect, it } from "vitest";

import {
  buildProvider,
  GcashProvider,
  MayaProvider,
  MockProvider,
} from "./index";

const BASE = "https://loans.example.test";

describe("MockProvider — intents", () => {
  const provider = new MockProvider({ baseUrl: BASE });

  it("derives the external id from the idempotency key", async () => {
    const intent = await provider.createIntent({
      loanId: "loan-1",
      amount: 5_000,
      idempotencyKey: "abc123",
      webhookUrl: `${BASE}/hook`,
    });
    expect(intent.externalId).toBe("mock_abc123");
    expect(intent.status).toBe("CREATED");
  });

  it("is idempotent — a retry produces the same external id", async () => {
    const once = await provider.createIntent({
      loanId: "loan-1",
      amount: 5_000,
      idempotencyKey: "same-key",
      webhookUrl: `${BASE}/hook`,
    });
    const twice = await provider.createIntent({
      // Same key, different amount: the key is what identifies the attempt,
      // so a retry must not mint a second intent.
      loanId: "loan-1",
      amount: 9_999,
      idempotencyKey: "same-key",
      webhookUrl: `${BASE}/hook`,
    });
    expect(twice.externalId).toBe(once.externalId);
  });

  it("points the payment URL at the configured base", async () => {
    const intent = await provider.createIntent({
      loanId: "loan-1",
      amount: 100,
      idempotencyKey: "k",
      webhookUrl: `${BASE}/hook`,
    });
    expect(intent.paymentUrl.startsWith(BASE)).toBe(true);
    expect(intent.paymentUrl).toContain("mock_k");
  });
});

describe("MockProvider — webhooks", () => {
  const provider = new MockProvider({ baseUrl: BASE });

  it("normalises a well-formed sandbox callback", () => {
    const event = provider.parseWebhook(
      {},
      {
        externalId: "mock_abc",
        status: "PAID",
        amount: 5_000,
        reference: "OR-123",
      },
    );
    expect(event).toMatchObject({
      externalId: "mock_abc",
      status: "PAID",
      amount: 5_000,
      reference: "OR-123",
    });
  });

  it("keeps the raw body for the audit trail", () => {
    const body = { externalId: "mock_abc", status: "PAID", extra: "kept" };
    expect(provider.parseWebhook({}, body).raw).toBe(body);
  });

  it("rejects a callback with no external id", () => {
    expect(() => provider.parseWebhook({}, { status: "PAID" })).toThrow(
      /externalId or status/i,
    );
  });

  it("rejects a callback with no status", () => {
    expect(() => provider.parseWebhook({}, { externalId: "mock_abc" })).toThrow(
      /externalId or status/i,
    );
  });

  it("rejects a non-object body instead of coercing it", () => {
    for (const body of [null, undefined, "PAID", 42]) {
      expect(() => provider.parseWebhook({}, body)).toThrow();
    }
  });
});

// ─── The security-relevant half ────────────────────────────────────────

describe("real providers refuse unverified webhooks", () => {
  const gcash = () =>
    new GcashProvider({
      baseUrl: "https://api.gcash.test",
      apiKey: "key",
      webhookSecret: "secret",
      successUrl: `${BASE}/done`,
    });
  const maya = () =>
    new MayaProvider({
      baseUrl: "https://api.maya.test",
      publicKey: "pk",
      secretKey: "sk",
      webhookSecret: "secret",
      successUrl: `${BASE}/done`,
    });

  const paidGcash = {
    data: { id: "gc_1", status: "PAID", amount: 5_000, reference: "OR-1" },
  };
  const paidMaya = {
    data: {
      attributes: {
        external_id: "my_1",
        status: "payment_paid",
        amount: 5_000,
      },
    },
  };

  it("still rejects a callback with no signature header at all", () => {
    expect(() => gcash().parseWebhook({}, paidGcash)).toThrow(/signature/i);
    expect(() => maya().parseWebhook({}, paidMaya)).toThrow(/signature/i);
  });

  /**
   * Regression. Before this, a forged header value was enough: the provider
   * checked only that the header existed, then never verified it against the
   * webhook secret. A "PAID" callback with `x-gcash-signature: anything`
   * would have been normalised and handed to handleWebhook, which records a
   * LoanPayment — money credited against a loan by anyone who could reach
   * the endpoint.
   */
  it("rejects a forged signature rather than trusting the header's presence", () => {
    expect(() =>
      gcash().parseWebhook(
        { "x-gcash-signature": "not-a-real-hmac" },
        paidGcash,
      ),
    ).toThrow(/not implemented/i);

    expect(() =>
      maya().parseWebhook(
        { "paymongo-signature": "not-a-real-hmac" },
        paidMaya,
      ),
    ).toThrow(/not implemented/i);
  });

  it("names the secret an implementer needs to verify against", () => {
    expect(() =>
      gcash().parseWebhook({ "x-gcash-signature": "x" }, paidGcash),
    ).toThrow(/GCASH_WEBHOOK_SECRET/);
    expect(() =>
      maya().parseWebhook({ "maya-signature": "x" }, paidMaya),
    ).toThrow(/MAYA_WEBHOOK_SECRET/);
  });

  it("keeps createIntent unimplemented, so neither half looks usable", () => {
    // The danger was the asymmetry: createIntent threw while parseWebhook
    // returned a normalised event, making the provider look half-wired.
    return Promise.all([
      expect(
        gcash().createIntent({
          loanId: "l",
          amount: 1,
          idempotencyKey: "k",
          webhookUrl: "u",
        }),
      ).rejects.toThrow(/not implemented/i),
      expect(
        maya().createIntent({
          loanId: "l",
          amount: 1,
          idempotencyKey: "k",
          webhookUrl: "u",
        }),
      ).rejects.toThrow(/not implemented/i),
    ]);
  });

  it("refuses to construct without credentials", () => {
    expect(
      () =>
        new GcashProvider({
          baseUrl: "b",
          apiKey: "",
          webhookSecret: "s",
          successUrl: "u",
        }),
    ).toThrow(/not configured/i);
    expect(
      () =>
        new MayaProvider({
          baseUrl: "b",
          publicKey: "p",
          secretKey: "",
          webhookSecret: "s",
          successUrl: "u",
        }),
    ).toThrow(/not configured/i);
  });
});

// ─── Factory ───────────────────────────────────────────────────────────

describe("buildProvider", () => {
  it("defaults to the sandbox provider when unset", () => {
    expect(buildProvider({}, BASE).name).toBe("MOCK");
    expect(buildProvider({ PAYMENT_PROVIDER: "mock" }, BASE).name).toBe("MOCK");
  });

  it("is case- and whitespace-insensitive about the value", () => {
    expect(buildProvider({ PAYMENT_PROVIDER: "  MOCK " }, BASE).name).toBe(
      "MOCK",
    );
  });

  it("builds the configured real provider", () => {
    expect(
      buildProvider(
        {
          PAYMENT_PROVIDER: "gcash",
          GCASH_API_KEY: "k",
          GCASH_WEBHOOK_SECRET: "s",
        },
        BASE,
      ).name,
    ).toBe("GCASH");
    expect(
      buildProvider({ PAYMENT_PROVIDER: "maya", MAYA_SECRET_KEY: "k" }, BASE)
        .name,
    ).toBe("MAYA");
  });

  it("surfaces missing credentials rather than starting half-configured", () => {
    expect(() => buildProvider({ PAYMENT_PROVIDER: "gcash" }, BASE)).toThrow(
      /not configured/i,
    );
  });

  /**
   * Regression. MockProvider accepts any webhook with no signature at all,
   * so silently falling back to it on a typo would turn a production
   * payments endpoint into one that trusts anything — with nothing in the
   * logs to say the configured provider had not been selected. Failing at
   * boot is the cheaper failure.
   */
  it("throws on an unrecognised provider instead of falling back to the mock", () => {
    for (const value of ["gcsh", "stripe", "GCASH_", "true"]) {
      expect(
        () => buildProvider({ PAYMENT_PROVIDER: value }, BASE),
        `"${value}" should not silently become the mock provider`,
      ).toThrow(/Unknown PAYMENT_PROVIDER/);
    }
  });

  it("treats an empty value as unset rather than unrecognised", () => {
    // An env var declared but left blank in a .env file is "not configured",
    // not a typo — that shouldn't stop the app booting in dev.
    expect(buildProvider({ PAYMENT_PROVIDER: "" }, BASE).name).toBe("MOCK");
    expect(buildProvider({ PAYMENT_PROVIDER: "   " }, BASE).name).toBe("MOCK");
  });
});
