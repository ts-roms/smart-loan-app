import type { FastifySchema } from "fastify";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * OpenAPI schemas, derived rather than written.
 *
 * The spec had 336 operations and **zero** response schemas — every one
 * of them documented as "Default Response" with no shape at all. It was
 * a route list wearing a spec's clothes: an integrator could see that
 * `GET /loans/:id` exists and nothing whatsoever about what comes back.
 *
 * The obvious fix — hand-write JSON Schema per route — is the wrong one.
 * It creates a second description of every payload, and the second
 * description is the one that goes stale: nothing fails when a field is
 * added to a response and not to its schema, so within a release the
 * spec lies in a way that is worse than saying nothing, because now it
 * looks authoritative.
 *
 * So everything here is derived from something that is already the
 * source of truth:
 *
 *   • REQUESTS come from the zod schemas the routes already validate
 *     with. If the schema drifts from the handler, the handler stops
 *     working — the feedback loop exists already, and this just
 *     publishes what it enforces.
 *   • RESPONSES are declared as zod objects beside the request schemas
 *     they live with, so a response schema is a real parser and can be
 *     asserted against an actual payload in a test rather than eyeballed.
 *   • ERRORS are shared components, because they are identical
 *     everywhere and repeating them 336 times would guarantee they
 *     diverge.
 *
 * ONE SHARP EDGE, DEFUSED. Fastify does not merely document a response
 * schema, it SERIALISES against it, and a property the schema does not
 * mention is stripped from the payload. Attaching a slightly incomplete
 * schema to a live route would therefore delete fields from responses
 * the web app depends on — a documentation change silently becoming a
 * breaking one, which is about the worst way for this work to go wrong.
 *
 * So every response schema here is emitted with
 * `additionalProperties: true`. Undeclared fields pass through
 * untouched, and the schema describes what is CONTRACTUAL rather than
 * claiming to be exhaustive. That is the honest reading anyway: these
 * say "you can rely on these fields", not "there is nothing else".
 */

/**
 * zod → JSON Schema, in the dialect the OpenAPI 3 generator wants.
 *
 * `target: "openApi3"` matters: the default emits draft-07 with `$schema`
 * and `nullable` expressed as a type union, neither of which OpenAPI 3.0
 * accepts.
 */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return numericExclusiveBounds(
    zodToJsonSchema(schema, {
      target: "openApi3",
      $refStrategy: "none",
    }),
  );
}

/**
 * Rewrite OpenAPI 3.0's boolean exclusive bounds into the numeric form.
 *
 * This one takes the server down, which is why it is here rather than
 * in a caller. `target: "openApi3"` renders `z.number().positive()` as
 * `{ minimum: 0, exclusiveMinimum: true }` — correct for OpenAPI 3.0 and
 * rejected by AJV, which compiles REQUEST schemas and accepts only
 * `{ exclusiveMinimum: 0 }`. The result is not a bad spec, it is
 * `FST_ERR_SCH_VALIDATION_BUILD: exclusiveMinimum must be number` at
 * boot: the API refuses to start because someone documented a route.
 *
 * Found the hard way while documenting the scoring catalog, where
 * `weight: z.number().positive()` was rewritten as a `.refine` to get
 * past it. That workaround is the wrong shape — it puts the fix in
 * whichever schema happens to trip first and leaves the next one to
 * rediscover it. Converted centrally instead, and `.positive()` restored.
 *
 * The two forms mean the same thing (`minimum: 0` + exclusive is `> 0`;
 * `exclusiveMinimum: 0` is `> 0`), and Swagger UI renders the numeric
 * form correctly, so nothing is lost by preferring the one that boots.
 */
function numericExclusiveBounds(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number") {
    schema.exclusiveMinimum = schema.minimum;
    delete schema.minimum;
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number") {
    schema.exclusiveMaximum = schema.maximum;
    delete schema.maximum;
  }
  for (const key of ["properties", "patternProperties"]) {
    const group = schema[key] as
      Record<string, Record<string, unknown>> | undefined;
    if (group) for (const v of Object.values(group)) numericExclusiveBounds(v);
  }
  for (const key of ["items", "additionalProperties", "not"]) {
    const child = schema[key];
    if (child && typeof child === "object")
      numericExclusiveBounds(child as Record<string, unknown>);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key] as Record<string, unknown>[] | undefined;
    if (Array.isArray(branches)) branches.forEach(numericExclusiveBounds);
  }
  return schema;
}

/**
 * The error body every route returns, in one place.
 *
 * Matches what the controllers actually send — `{ error, message? }`,
 * plus `issues` on a validation failure. Written as a plain object
 * rather than derived from zod because no zod schema for it exists: it
 * is produced by hand in ~40 controllers, and inventing a parser for it
 * here would be a second source of truth with nothing enforcing it.
 */
const ERROR_BODY = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["error"],
  additionalProperties: true,
} as const;

/*
 * `additionalProperties: true` on the ISSUE objects, not just on the
 * envelope, and it is load-bearing.
 *
 * The first version of this described an issue as `{ type: "object" }`
 * with no properties, which is a perfectly reasonable-looking way to say
 * "some object". Fastify then serialised every issue against it and
 * stripped all of them to `{}` — so a validation failure came back as
 * `{"error":"ValidationError","issues":[{}]}`, technically the right
 * shape and completely useless. The exact footgun this file warns about,
 * landing on the file that warns about it.
 */
const VALIDATION_BODY = {
  type: "object",
  properties: {
    error: { type: "string" },
    issues: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["error"],
  additionalProperties: true,
} as const;

/**
 * Standard failures, by status.
 *
 * 409 carries the convention this codebase uses everywhere: the request
 * was well-formed and the caller was entitled to make it — the target's
 * STATE is what refuses. An integrator who reads 409 as "bad request"
 * and retries with different input will retry forever.
 */
export const ERRORS = {
  400: { description: "Validation failed.", ...content(VALIDATION_BODY) },
  401: {
    description: "Missing or invalid credentials.",
    ...content(ERROR_BODY),
  },
  402: {
    description: "Feature not included in the tenant's licence.",
    ...content(ERROR_BODY),
  },
  403: {
    description: "Authenticated but not permitted.",
    ...content(ERROR_BODY),
  },
  404: { description: "No such record.", ...content(ERROR_BODY) },
  409: {
    description:
      "Well-formed and permitted, but the target's state refuses it. " +
      "Retrying the same request unchanged will fail the same way.",
    ...content(ERROR_BODY),
  },
  410: {
    description:
      "The thing existed and has lapsed. Distinct from 404 on purpose: " +
      "the link was real, so the answer is to issue a new one, not to " +
      "conclude it never existed. Every co-maker consent operation " +
      "answers this once the invite passes its expiry.",
    ...content(ERROR_BODY),
  },
  413: {
    description: "The uploaded file exceeds the size cap.",
    ...content(ERROR_BODY),
  },
  429: { description: "Rate limited.", ...content(ERROR_BODY) },
} as const;

function content(schema: unknown) {
  return { content: { "application/json": { schema } } };
}

/**
 * Let undeclared fields through the serialiser.
 *
 * Fastify strips any property a response schema does not mention, so an
 * incomplete schema on a live route silently deletes fields the web app
 * reads. Recursing rather than setting it only at the top level,
 * because nested objects — a `customer` inside a loan, a `rows` array of
 * records — are exactly where a schema is most likely to be a summary
 * rather than the full truth.
 */
function permissive(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object") {
    schema.additionalProperties = true;
    const props = schema.properties as
      Record<string, Record<string, unknown>> | undefined;
    if (props) for (const v of Object.values(props)) permissive(v);
  }
  if (schema.type === "array" && schema.items) {
    permissive(schema.items as Record<string, unknown>);
  }
  return schema;
}

/** A 204, which has no body and therefore no schema. */
export const NO_CONTENT = { description: "Done. No body." } as const;

export interface RouteSchemaInput {
  /** One line. Shows as the operation summary in /docs. */
  summary: string;
  /** Groups the operation in /docs. Use the feature name. */
  tags: string[];
  body?: z.ZodType;
  querystring?: z.ZodType;
  params?: z.ZodType;
  /** 200 body. Omit for a 204. */
  response?: z.ZodType;
  /**
   * Status for `response`, when it is not 200.
   *
   * 207 is here because `POST /accounting/journal/reverse-bulk` really
   * answers Multi-Status — some reversals land and some are refused in
   * one call. It was left undocumented rather than publish a 200 it
   * never sends, which was the right call and a one-word fix.
   */
  status?: 200 | 201 | 202 | 207;
  /**
   * Which standard failures this route can return. Listed rather than
   * assumed: "this can 409" is real API documentation, and a blanket
   * every-error-on-every-route would tell a reader nothing.
   */
  errors?: (keyof typeof ERRORS)[];
}

/**
 * Build the `schema` Fastify wants from the pieces a route already has.
 *
 * Attaching `body`/`querystring`/`params` DOES make Fastify validate
 * them — there is no documentation-only slot, it is the same field. That
 * is fine, and it is also why `app.ts` installs a schema error
 * formatter: Fastify's default rejection is a bare
 * `{ "error": "Bad Request" }`, while every controller here returns
 * `{ error: "ValidationError", issues: [...] }` naming the field at
 * fault. Documenting a request must not make the API less useful to the
 * people reading the documentation, so the formatter reshapes Fastify's
 * rejection into the body callers already receive. The controller's own
 * parse still runs for everything Fastify lets through.
 */
export function routeSchema(input: RouteSchemaInput): FastifySchema {
  const responses: Record<string, unknown> = {};

  if (input.response) {
    responses[String(input.status ?? 200)] = {
      description: "Success.",
      ...content(permissive(jsonSchema(input.response))),
    };
  } else {
    responses["204"] = NO_CONTENT;
  }

  for (const code of input.errors ?? []) {
    responses[String(code)] = ERRORS[code];
  }

  return {
    summary: input.summary,
    tags: input.tags,
    ...(input.body ? { body: jsonSchema(input.body) } : {}),
    ...(input.querystring
      ? { querystring: jsonSchema(input.querystring) }
      : {}),
    ...(input.params ? { params: jsonSchema(input.params) } : {}),
    response: responses,
  };
}
