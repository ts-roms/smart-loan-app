import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ERRORS, jsonSchema, routeSchema } from "./openapi";

/**
 * Invariant: documenting a response must not change it.
 *
 * Fastify does not merely publish a response schema, it SERIALISES
 * against it — a property the schema does not mention is stripped from
 * the payload. Attaching a slightly incomplete schema to a live route
 * therefore deletes fields the web app reads, which turns a
 * documentation change into a breaking one with nothing failing in
 * between.
 *
 * `additionalProperties: true` is the whole defence, and it is one word
 * in one helper. If it is ever removed while "tidying up" the emitted
 * schemas, these tests are what says so — and the emitted JSON is the
 * only place that can be checked, because the damage happens inside
 * Fastify's serialiser and shows up nowhere else until an integration
 * breaks.
 */

describe("response schemas never strip a field", () => {
  const shape = z.object({ id: z.string(), name: z.string() });

  it("marks a response object as permissive", () => {
    const s = routeSchema({ summary: "x", tags: ["t"], response: shape });
    const body = responseSchema(s, 200);

    expect(body.additionalProperties).toBe(true);
  });

  it("marks NESTED objects permissive too", () => {
    /*
     * The likely place for a schema to be a summary rather than the
     * truth: a `customer` embedded in a loan, or the rows of a report.
     * Top-level-only would let those be silently pruned.
     */
    const s = routeSchema({
      summary: "x",
      tags: ["t"],
      response: z.object({ customer: shape }),
    });
    const body = responseSchema(s, 200);
    const nested = (body.properties as Record<string, Record<string, unknown>>)
      .customer!;

    expect(nested.additionalProperties).toBe(true);
  });

  it("marks the ITEMS of an array response permissive", () => {
    const s = routeSchema({
      summary: "x",
      tags: ["t"],
      response: z.array(shape),
    });
    const body = responseSchema(s, 200);
    const items = body.items as Record<string, unknown>;

    expect(items.additionalProperties).toBe(true);
  });

  it("does not make REQUEST bodies permissive", () => {
    /*
     * Requests are the opposite case. Nothing serialises them, and a
     * published request schema that shrugs at unknown fields tells a
     * caller their typo will be accepted when the zod parser in the
     * controller will reject it.
     */
    const s = routeSchema({ summary: "x", tags: ["t"], body: shape });
    const body = s.body as Record<string, unknown>;

    expect(body.additionalProperties).not.toBe(true);
  });
});

describe("what the spec says about failure", () => {
  it("only lists the errors a route declares", () => {
    // "This can 409" is real documentation. Every error on every route
    // would be noise a reader learns to skip.
    const s = routeSchema({
      summary: "x",
      tags: ["t"],
      response: z.object({}),
      errors: [401, 409],
    });
    const responses = s.response as Record<string, unknown>;

    expect(Object.keys(responses).sort()).toEqual(["200", "401", "409"]);
  });

  it("explains 409 as a state refusal, not a bad request", () => {
    /*
     * The convention this codebase uses everywhere, and the one an
     * integrator is most likely to get wrong: a 409 means the request
     * was well-formed and permitted and the TARGET refused it. Someone
     * who reads it as "bad input" retries with different input forever.
     */
    expect(ERRORS[409].description).toMatch(/state refuses/i);
    expect(ERRORS[409].description).toMatch(/same way/i);
  });

  it("gives a 204 no schema, because it has no body", () => {
    const s = routeSchema({ summary: "x", tags: ["t"] });
    const responses = s.response as Record<string, Record<string, unknown>>;

    expect(responses["204"]).toBeDefined();
    expect(responses["204"]!.content).toBeUndefined();
  });
});

describe("the emitted dialect", () => {
  it("is OpenAPI 3, not draft-07", () => {
    /*
     * The default target emits `$schema` and expresses nullable as a
     * type union, neither of which OpenAPI 3.0 accepts — the generator
     * takes it without complaint and produces a spec other tools reject.
     */
    const s = jsonSchema(z.object({ a: z.string().nullable() }));

    expect(s.$schema).toBeUndefined();
    const a = (s.properties as Record<string, Record<string, unknown>>).a!;
    expect(a.nullable).toBe(true);
  });

  it("inlines rather than emitting $ref", () => {
    // @fastify/swagger resolves route schemas independently; a $ref to
    // a definition Fastify never saw resolves to nothing.
    const inner = z.object({ v: z.string() });
    const s = jsonSchema(z.object({ a: inner, b: inner }));

    expect(JSON.stringify(s)).not.toContain("$ref");
  });
});

/**
 * Read an `x-` extension off an emitted schema.
 *
 * `FastifySchema` names only the keys @fastify/swagger understands and
 * has no index signature, so the extensions this helper emits cannot be
 * indexed directly. That is the same constraint `routeSchema` works
 * around when it builds them, and going through one reader here keeps
 * the cast in a single place rather than at every assertion.
 */
function ext(s: ReturnType<typeof routeSchema>, key: string): unknown {
  return (s as unknown as Record<string, unknown>)[key];
}

function responseSchema(
  s: ReturnType<typeof routeSchema>,
  status: number,
): Record<string, unknown> {
  const responses = s.response as Record<string, Record<string, unknown>>;
  const content = responses[String(status)]!.content as Record<
    string,
    { schema: Record<string, unknown> }
  >;
  return content["application/json"]!.schema;
}

/**
 * Invariant: an error body survives its own schema.
 *
 * The serialisation footgun this file exists to warn about landed on
 * this file's own error schemas first. `issues` was described as
 * `{ type: "array", items: { type: "object" } }` — a perfectly
 * reasonable way to say "some objects" — and Fastify duly stripped every
 * property from every issue, so a validation failure came back as
 * `{"error":"ValidationError","issues":[{}]}`: the right shape, and
 * completely useless to whoever had to fix their request.
 */
describe("error bodies are not stripped by their own schema", () => {
  const bodyOf = (code: keyof typeof ERRORS) => {
    const content = (
      ERRORS[code] as {
        content: Record<string, { schema: Record<string, unknown> }>;
      }
    ).content;
    return content["application/json"]!.schema;
  };

  it("lets an error envelope carry fields it does not name", () => {
    /*
     * 410 and 413 are in this list from the day they were added, not
     * from the day something broke. Both were introduced for the
     * co-maker consent routes, and 410's body carries the same
     * `{ error, message }` every other refusal does — the whole reason
     * they went into ERRORS centrally rather than being hand-rolled in
     * the feature file was to keep exactly this invariant shared.
     */
    for (const code of [401, 403, 404, 409, 410, 413] as const) {
      expect(bodyOf(code).additionalProperties, String(code)).toBe(true);
    }
  });

  it("explains 410 as a lapsed thing, not a missing one", () => {
    /*
     * The distinction the status exists to carry. An integrator who
     * collapses 410 into 404 tells a co-maker their invite never
     * existed, when the answer they need is "ask for a new link" — so
     * the description has to say the difference out loud, the same way
     * 409's does.
     */
    expect(ERRORS[410].description).toMatch(/lapsed/i);
    expect(ERRORS[410].description).toMatch(/404/);
  });

  it("lets each validation ISSUE keep its contents", () => {
    const props = bodyOf(400).properties as Record<
      string,
      { items?: Record<string, unknown> }
    >;

    expect(props.issues!.items!.additionalProperties).toBe(true);
  });
});

/**
 * Invariant: documenting a route cannot stop the server from starting.
 *
 * The sharpest failure this helper has produced. `target: "openApi3"`
 * renders `z.number().positive()` as `{ minimum: 0, exclusiveMinimum:
 * true }` — correct OpenAPI 3.0, and rejected by AJV, which compiles
 * REQUEST schemas and accepts only `{ exclusiveMinimum: 0 }`. The result
 * is not a slightly wrong spec: it is
 * `FST_ERR_SCH_VALIDATION_BUILD: exclusiveMinimum must be number` while
 * building the route, and the API refuses to boot because somebody
 * documented it.
 *
 * It was first worked around in the schema that happened to trip it,
 * which would have left every later one to rediscover it.
 */
describe("exclusive bounds are emitted in the form AJV accepts", () => {
  it("converts a positive() bound to the numeric form", () => {
    const s = jsonSchema(z.object({ weight: z.number().positive() }));
    const weight = (s.properties as Record<string, Record<string, unknown>>)
      .weight!;

    expect(weight.exclusiveMinimum).toBe(0);
    expect(weight.minimum).toBeUndefined();
  });

  it("converts an upper bound too", () => {
    const s = jsonSchema(z.object({ r: z.number().lt(1) }));
    const r = (s.properties as Record<string, Record<string, unknown>>).r!;

    expect(r.exclusiveMaximum).toBe(1);
    expect(r.maximum).toBeUndefined();
  });

  it("leaves inclusive bounds alone", () => {
    // `.min(0)` means >= 0 and must stay `minimum: 0`. Converting it
    // would quietly reject a legitimate zero.
    const s = jsonSchema(z.object({ w: z.number().min(0).max(1) }));
    const w = (s.properties as Record<string, Record<string, unknown>>).w!;

    expect(w.minimum).toBe(0);
    expect(w.maximum).toBe(1);
    expect(w.exclusiveMinimum).toBeUndefined();
  });

  it("reaches a bound nested inside an array of objects", () => {
    // Where the conversion would most plausibly be forgotten.
    const s = jsonSchema(
      z.object({ rows: z.array(z.object({ n: z.number().positive() })) }),
    );
    const rows = (s.properties as Record<string, Record<string, unknown>>)
      .rows!;
    const item = rows.items as Record<string, unknown>;
    const n = (item.properties as Record<string, Record<string, unknown>>).n!;

    expect(n.exclusiveMinimum).toBe(0);
  });

  it("actually builds a Fastify route — the failure was at boot", async () => {
    /*
     * The assertions above check the emitted JSON; this checks the thing
     * that broke. AJV compiles the request schema when the route is
     * registered, so `app.ready()` is where the old form threw.
     */
    const app = Fastify({ logger: false });
    app.post(
      "/thing",
      {
        schema: routeSchema({
          summary: "A thing.",
          tags: ["test"],
          body: z.object({ weight: z.number().positive().max(1000) }),
          response: z.object({ ok: z.boolean() }),
        }),
      },
      async () => ({ ok: true }),
    );

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});

/**
 * Invariant: every operation states its own authentication posture.
 *
 * The spec was NOT silent about authentication before this — `app.ts`
 * declares a global `security: [{ bearerAuth: [] }]`, so every operation
 * inherited "needs a token". That is the right default and the wrong
 * answer for twenty-four of them: the document told an integrator that
 * `POST /public/leads`, the co-maker consent links and the gateway
 * settlement callback all require a bearer JWT. A payment gateway has no
 * JWT to give, so the one caller who could least afford to go hunting
 * for credentials was the one being sent to hunt.
 *
 * Emitting `security` positively on every operation — `[]` on the
 * anonymous ones — is what makes the split both correct and countable.
 */
describe("every operation declares whether it needs a token", () => {
  const base = { summary: "x", tags: ["t"] };

  it("requires the tenant bearer token by default", () => {
    const s = routeSchema({ ...base, response: z.object({}) });

    expect(s.security).toEqual([{ bearerAuth: [] }]);
  });

  it("emits an EMPTY security list for an anonymous route", () => {
    /*
     * `[]` is not the same as omitting the field. Omitted, the operation
     * inherits the global requirement; `[]` overrides it, and is the
     * only way OpenAPI 3 has of saying "this one takes no credential".
     */
    const s = routeSchema({
      ...base,
      public: "a payment gateway carries no JWT.",
      response: z.object({}),
    });

    expect(s.security).toEqual([]);
  });

  it("names the PLATFORM scheme for the vendor control plane", () => {
    /*
     * Two schemes because there are two credentials, and each side
     * rejects the other's token. One shared `bearerAuth` would tell a
     * cooperative's integrator that the token they already hold reaches
     * /platform/*, which is the most expensive thing this field could
     * get wrong.
     */
    const s = routeSchema({
      ...base,
      auth: "platform",
      response: z.object({}),
    });

    expect(s.security).toEqual([{ platformAuth: [] }]);
  });

  it("puts the REASON a route is public into the description", () => {
    // A bare boolean answers "is this public" and leaves "…should it
    // be?" to a reviewer's memory.
    const s = routeSchema({
      ...base,
      public: "a payment gateway carries no JWT.",
      response: z.object({}),
    });

    expect(s.description).toContain("gateway carries no JWT");
  });
});

describe("what the spec says about authorisation", () => {
  const base = { summary: "x", tags: ["t"], response: z.object({}) };

  it("publishes the permission key as a machine-readable extension", () => {
    const s = routeSchema({ ...base, permission: "loans.approve" });

    expect(ext(s, "x-required-permission")).toEqual(["loans.approve"]);
    expect(s.description).toContain("`loans.approve`");
  });

  it("says a multi-key gate is ANY, not ALL", () => {
    /*
     * `app.requirePermission("payments.intents", "loans.read")` passes
     * when the caller holds EITHER. An integrator who reads the pair as
     * a required set asks an administrator for a role nobody needs.
     */
    const s = routeSchema({
      ...base,
      permission: ["payments.intents", "loans.read"],
    });

    expect(ext(s, "x-required-permission")).toEqual([
      "payments.intents",
      "loans.read",
    ]);
    expect(s.description).toMatch(/ANY ONE/);
    expect(s.description).toMatch(/not a set that must all be held/);
  });

  it("keeps platform ROLES out of the permission field", () => {
    /*
     * Platform roles are a different mechanism against a different
     * identity table and never appear in GET /auth/me/permissions.
     * Folding them together would publish a permission key that no
     * tenant role can hold.
     */
    const s = routeSchema({
      ...base,
      auth: "platform",
      platformRole: "PLATFORM_ADMIN",
    });

    expect(ext(s, "x-required-platform-role")).toEqual(["PLATFORM_ADMIN"]);
    expect(ext(s, "x-required-permission")).toBeUndefined();
  });

  it("says nothing at all when a route has no permission gate", () => {
    /*
     * Authenticated-but-ungated is a real posture here — `/auth/me`,
     * `/loans/quote`, the whole delegations group. Claiming a permission
     * that is not checked would be worse than silence.
     */
    const s = routeSchema(base);

    expect(ext(s, "x-required-permission")).toBeUndefined();
    expect(s.description).toBeUndefined();
  });
});

/**
 * Invariant: documenting idempotency must not start rejecting requests.
 *
 * `headers` is not a documentation-only slot any more than `body` is —
 * Fastify compiles it with AJV and validates at preValidation. Marking
 * `Idempotency-Key` required would turn every caller that omits it
 * (which is all of them, the web app included) into a 400;
 * `additionalProperties: false` would reject every request carrying any
 * other header, i.e. every request. Both are one word away at all times,
 * and both would turn a documentation change into an outage — the same
 * shape of failure as the serialisation footgun at the top of this file.
 */
describe("the idempotency header is documented, not enforced", () => {
  const withHeader = routeSchema({
    summary: "x",
    tags: ["t"],
    idempotency: { mode: "header", field: "idempotencyKey" },
    response: z.object({}),
  });

  it("describes the header as a parameter", () => {
    const headers = withHeader.headers as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(headers.properties)).toContain("idempotency-key");
  });

  it("does not make it REQUIRED", () => {
    const headers = withHeader.headers as { required?: string[] };

    expect(headers.required).toBeUndefined();
  });

  it("does not close the header object", () => {
    const headers = withHeader.headers as { additionalProperties?: boolean };

    expect(headers.additionalProperties).not.toBe(false);
  });

  it("serves a request carrying no key and unrelated headers", async () => {
    /*
     * The assertions above check the emitted JSON; this checks the thing
     * that would break. AJV compiles the header schema at registration
     * and runs it on every request, so a route that only 400s in
     * production would still pass every schema-shaped assertion above.
     */
    const app = Fastify({ logger: false });
    app.post(
      "/pay",
      {
        schema: routeSchema({
          summary: "Record a payment.",
          tags: ["test"],
          idempotency: { mode: "header", field: "idempotencyKey" },
          response: z.object({ ok: z.boolean() }),
        }),
      },
      async () => ({ ok: true }),
    );
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "x-request-id": "abc", "user-agent": "probe" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it("only attaches a header schema in HEADER mode", () => {
    // The body-keyed and server-derived routes read no header at all,
    // and a schema for one would be a documented lie.
    const body = routeSchema({
      summary: "x",
      tags: ["t"],
      idempotency: { mode: "body", field: "idempotencyKey" },
      response: z.object({}),
    });

    expect(body.headers).toBeUndefined();
  });
});

describe("idempotency prose tells the caller where the key goes", () => {
  const base = { summary: "x", tags: ["t"], response: z.object({}) };

  it("warns that an omitted key means NO deduplication", () => {
    /*
     * The failure mode is silent. With no key the column is NULL,
     * Postgres treats NULLs as distinct, and two identical calls make
     * two payments — with nothing raised to notice.
     */
    const s = routeSchema({
      ...base,
      idempotency: { mode: "header", field: "idempotencyKey" },
    });

    expect(s.description).toMatch(/ACCEPTED, not required/);
    expect(s.description).toMatch(/two identical calls/i);
  });

  it("says the HEADER is ignored on a body-keyed route", () => {
    /*
     * `POST /payments/intents` never reads `Idempotency-Key`, and an
     * absent body field is filled with a fresh UUID. A caller
     * generalising from the payments endpoint gets a second intent and
     * no error — the exact mistake this sentence exists to prevent.
     */
    const s = routeSchema({
      ...base,
      idempotency: { mode: "body", field: "idempotencyKey" },
    });

    expect(s.description).toMatch(/HEADER IS IGNORED HERE/);
  });

  it("tells a gateway it needs no dedupe layer of its own", () => {
    const s = routeSchema({
      ...base,
      public: "a gateway carries no JWT.",
      idempotency: { mode: "server", derivedFrom: "the payment intent id" },
    });

    expect(s.description).toMatch(/caller supplies nothing/);
    expect(s.description).toContain("the payment intent id");
  });

  it("records that no route REQUIRES a key", () => {
    const s = routeSchema({
      ...base,
      idempotency: { mode: "header", field: "idempotencyKey" },
    });

    expect(ext(s, "x-idempotency")).toMatchObject({
      mode: "header",
      required: false,
      field: "idempotencyKey",
    });
  });
});

describe("the two statuses the /public batch reported as unsayable", () => {
  it("can now declare 501, and explains it is a MODE signal", () => {
    /*
     * Single-tenant is the DEFAULT mode, so 501 is not an edge case on
     * the two signup operations — it is the only answer they ever give
     * on most deployments. A spec that documented a 202 they will never
     * send while staying silent about the status they always do was
     * describing a different server.
     */
    expect(ERRORS[501].description).toMatch(/mode signal/i);
    expect(ERRORS[501].description).toMatch(/not a permission problem/i);
  });

  it("still has no shared 500, on purpose", () => {
    /*
     * `errors` is a per-route list precisely because a blanket
     * every-error-on-every-route is noise a reader learns to skip — and
     * EVERY route can 500. A shared entry would be the one that gets
     * added everywhere and means nothing.
     */
    expect(ERRORS).not.toHaveProperty("500");
  });
});
