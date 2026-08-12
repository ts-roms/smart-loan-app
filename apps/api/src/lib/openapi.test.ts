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
    for (const code of [401, 403, 404, 409] as const) {
      expect(bodyOf(code).additionalProperties, String(code)).toBe(true);
    }
  });

  it("lets each validation ISSUE keep its contents", () => {
    const props = bodyOf(400).properties as Record<
      string,
      { items?: Record<string, unknown> }
    >;

    expect(props.issues!.items!.additionalProperties).toBe(true);
  });
});
