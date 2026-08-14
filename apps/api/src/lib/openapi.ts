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
 *   • AUTHENTICATION, AUTHORISATION and IDEMPOTENCY are declared by the
 *     route beside the gate that enforces them, and rendered from that
 *     one declaration into `security`, the operation `description` and
 *     `x-` extensions. See `routeSchema` for why `security` is emitted
 *     positively on every operation rather than left to the global
 *     default in `app.ts`, and `RouteSchemaInput.public` for why an
 *     anonymous route carries a written reason rather than a boolean.
 *
 * Those last three are the half of §67 the response-schema programme
 * did not reach. They are worth stating precisely for the same reason
 * the response shapes were: an integrator cannot discover from a route
 * list that retrying a payment is safe, and "when in doubt, retry" and
 * "when in doubt, don't" are both wrong answers to a question the
 * document can simply answer.
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
  501: {
    description:
      "This installation does not implement the feature. A mode signal, " +
      "not a failure and not a permission problem: the request was " +
      "well-formed and the caller was entitled to make it, but the " +
      "server is configured without the mode it needs. `/public/signup` " +
      "and `/public/signup/confirm` answer this on a single-tenant " +
      "deployment. No token, no input and no retry changes it.",
    ...content(ERROR_BODY),
  },
} as const;

/*
 * 501 IS here; 500 deliberately is not.
 *
 * Both were reported as reachable-but-undeclarable by the batch that
 * documented `/public/*`, and they are not the same kind of thing.
 *
 * 501 is a CONTRACT. `/public/signup` and `/public/signup/confirm`
 * send it whenever the server is not in multi-tenant mode, which is the
 * default — so on most deployments it is not an edge case, it is the
 * only answer those two operations ever give. It carries the same
 * `{ error, message }` envelope as every other refusal, and it belongs
 * beside 402 for the same reason 402 is here: both say "the request was
 * fine, this installation just doesn't do that", and both are wrongly
 * read as authorisation failures by anyone who has to guess.
 *
 * 500 `ProvisioningFailed` is NOT a contract, and putting it in a
 * shared table would break the one rule that makes this table useful.
 * `errors` is a per-route list precisely because "this can 409" is real
 * documentation and a blanket every-error-on-every-route is noise a
 * reader learns to skip — and EVERY route can 500. The moment a shared
 * 500 exists it is the entry that gets added everywhere and means
 * nothing. It also would not describe one thing: `ModeDisabled` is a
 * 501 from `public.controller` and a **400** from
 * `platform.controller`'s retry-provisioning, so a shared entry would
 * paper over a genuine inconsistency between two surfaces rather than
 * document either. The one route where a 500 is a NAMED, expected
 * outcome says so in its own summary, which is where a fact that
 * generalises to nothing else belongs.
 */

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

/**
 * How a route deduplicates a retry.
 *
 * Three genuinely different mechanisms live in this API, and collapsing
 * them into one "idempotent: true" flag would be the lie. A caller needs
 * to know WHERE the key goes, because sending it in the wrong place is
 * silent — `POST /payments/intents` ignores the `Idempotency-Key`
 * header entirely and mints a fresh UUID, so a caller who assumes the
 * header works there gets a second intent and no error.
 *
 *   • `header` — the caller sends `Idempotency-Key`.
 *   • `body`   — the caller sends a named field in the request body.
 *   • `server` — the caller sends nothing; the server derives the key.
 *                Documented rather than omitted because "you cannot
 *                make this safe, it already is" is exactly what a
 *                gateway integrator needs to hear before building a
 *                dedupe layer that is not needed.
 */
export interface IdempotencyInput {
  mode: "header" | "body" | "server";
  /**
   * Body field carrying the key. For `body` mode this IS the mechanism;
   * for `header` mode it is the documented fallback when both exist.
   */
  field?: string;
  /**
   * Where the key comes from, for `server` mode.
   */
  derivedFrom?: string;
  /**
   * A truth about THIS route that the general wording gets wrong.
   * Appended verbatim.
   */
  note?: string;
}

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
  /**
   * This operation is ANONYMOUS — no bearer token.
   *
   * Opt-out rather than opt-in, because bearer auth is the default here
   * and a default that has to be repeated 315 times is wrong on the
   * first one somebody forgets. The exceptions are few, deliberate and
   * individually surprising (`POST /auth/logout` takes no token;
   * `/payments/webhook/*` cannot, because a gateway carries no JWT), so
   * they are the ones worth making a route state out loud.
   *
   * The value is the REASON, not `true`. A bare boolean answers "is
   * this public" and leaves "…should it be?" to a reviewer's memory;
   * the reason is what lets the next reader tell a deliberate anonymous
   * endpoint from a forgotten hook. It is published, so it has to be
   * true and about this route.
   */
  public?: string;
  /**
   * WHICH credential, when it is not the ordinary tenant token.
   *
   * `/platform/*` is a different API behind the same host: its token
   * comes from `POST /platform/auth/login`, carries `platform: true`,
   * and a tenant token is actively REJECTED there (and vice versa —
   * `app.authenticate` 401s any JWT carrying `platform: true`). One
   * `bearerAuth` scheme covering both would tell an integrator that the
   * token they already hold works on the vendor console, which is the
   * one thing that is guaranteed not to be true.
   */
  auth?: "tenant" | "platform";
  /**
   * Platform role(s) `requirePlatformRole` gates this route on.
   *
   * A separate field from `permission` because it is a separate
   * mechanism against a separate identity table — platform roles are
   * not RBAC permission keys and do not appear in
   * `GET /auth/me/permissions`. Folding them together would publish a
   * permission key that no tenant role can ever hold.
   */
  platformRole?: string | string[];
  /**
   * Permission key(s) `requirePermission` gates this route on.
   *
   * An array means ANY of them suffices — that is exactly what
   * `app.requirePermission("payments.intents", "loans.read")` does, and
   * reading it as "all of them" is the mistake worth preventing.
   *
   * Omit on a route with no permission gate. Authenticated-but-ungated
   * is a real posture here (`/auth/me`, `/uploads-api/*`) and claiming
   * a permission it does not check would be worse than saying nothing.
   */
  permission?: string | string[];
  /** How a retry is deduplicated, when it is. */
  idempotency?: IdempotencyInput;
}

/** `Idempotency-Key`, described once. */
const IDEMPOTENCY_HEADER = {
  type: "object",
  properties: {
    "idempotency-key": {
      type: "string",
      description:
        "Opaque caller-chosen key. A repeat with the same key returns " +
        "the original result and records no second payment.",
    },
  },
  /*
   * `additionalProperties` is left at its default (true) and REQUIRED
   * is left empty, and both matter.
   *
   * Fastify validates `headers` at preValidation with AJV, so this is
   * not a documentation-only slot any more than `body` is. Marking the
   * key required would turn every existing caller that omits it — which
   * is all of them, including the web app — into a 400, and turn a
   * documentation change into an outage. Setting
   * `additionalProperties: false` would reject every request that
   * carries any other header, i.e. every request.
   *
   * No `minLength` either, deliberately. The BODY field is
   * `.min(8)`; the header has never been length-checked, and adding a
   * bound here would start rejecting short keys that work today. The
   * spec's job is to say what the route does, not to quietly tighten
   * it.
   */
} as const;

/** The prose for one idempotency mode. */
function idempotencyText(i: IdempotencyInput): string {
  const head = "**Idempotency.**";
  const replay =
    "A repeat carrying the same key returns the ORIGINAL result and " +
    "creates no second financial record — a retry after a timeout is " +
    "safe, and is not merely rejected.";

  let how: string;
  if (i.mode === "header") {
    how =
      "Send `Idempotency-Key`. It is ACCEPTED, not required: omit it " +
      "and the request is not idempotent at all — two identical calls " +
      "produce two records, because the stored key is NULL and Postgres " +
      "treats NULLs as distinct." +
      (i.field
        ? ` A \`${i.field}\` field in the body is accepted as a fallback ` +
          "for callers that cannot set headers; the header wins when both " +
          "are present."
        : "");
  } else if (i.mode === "body") {
    how =
      `Send \`${i.field ?? "idempotencyKey"}\` in the request body. The ` +
      "`Idempotency-Key` HEADER IS IGNORED HERE — sending it instead of " +
      "the body field fails silently, because an absent field is filled " +
      "with a fresh UUID and the call is simply not deduplicated.";
  } else {
    how =
      "The caller supplies nothing. The server derives the key" +
      (i.derivedFrom ? ` from ${i.derivedFrom}` : "") +
      ", so an at-least-once delivery is already safe to redeliver and " +
      "no caller-side dedupe is needed.";
  }

  return [head, how, replay, i.note].filter(Boolean).join(" ");
}

/** The prose for a permission gate. */
function permissionText(keys: string[]): string {
  if (keys.length === 1) {
    return `**Authorization.** Requires the \`${keys[0]!}\` permission.`;
  }
  return (
    "**Authorization.** Requires ANY ONE of " +
    keys.map((k) => `\`${k}\``).join(", ") +
    " — they are alternatives, not a set that must all be held."
  );
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
 *
 * ── AUTHENTICATION, AUTHORISATION, IDEMPOTENCY ──
 *
 * `security` is emitted on EVERY operation, positively, including the
 * anonymous ones (as `security: []`).
 *
 * A global `security: [{ bearerAuth: [] }]` was already declared in
 * `app.ts`, so it is not true that the spec said nothing about
 * authentication — every operation inherited "needs a token". The
 * problem was the opposite one, and worse: that inheritance was applied
 * to the twenty-four operations that take NO token, so the document
 * stated, with the authority of a machine-readable field, that
 * `POST /public/leads` and the gateway settlement callback require a
 * bearer JWT. An integrator who believed it would go hunting for
 * credentials that cannot exist for a callback a payment gateway makes.
 *
 * Emitting it per operation rather than leaning on the global also
 * makes the split COUNTABLE. "Which of these need a token" stops being
 * a question answered by reading 44 route files and becomes one `jq`
 * over `/docs/json` — the only form in which the answer stays true
 * after the next batch.
 *
 * The global stays exactly where it is. It is the right default for
 * anything added tomorrow; this is a belt beside it, not a replacement.
 *
 * Authorisation and idempotency go into `description` AND into `x-`
 * extension fields. The prose is for the human reading /docs; the
 * extensions are for anything generating a client, and @fastify/swagger
 * copies any schema key beginning with `x-` onto the operation
 * verbatim. Neither is a second SOURCE of truth — both are rendered
 * from the same one input the route declares.
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

  const permissions =
    input.permission === undefined
      ? []
      : Array.isArray(input.permission)
        ? input.permission
        : [input.permission];

  const platformRoles =
    input.platformRole === undefined
      ? []
      : Array.isArray(input.platformRole)
        ? input.platformRole
        : [input.platformRole];

  const scheme = input.auth === "platform" ? "platformAuth" : "bearerAuth";

  const paragraphs: string[] = [];
  if (input.public) {
    paragraphs.push(`**Authentication.** None — ${input.public}`);
  } else if (input.auth === "platform") {
    paragraphs.push(
      "**Authentication.** A PLATFORM token from " +
        "`POST /platform/auth/login`, not a tenant token. The two are " +
        "not interchangeable in either direction: a tenant token is " +
        "rejected here, and a platform token is rejected by every " +
        "`/api/v1` route.",
    );
  }
  if (platformRoles.length > 0) {
    paragraphs.push(
      platformRoles.length === 1
        ? `**Authorization.** Requires the \`${platformRoles[0]!}\` platform role.`
        : "**Authorization.** Requires ANY ONE of the platform roles " +
            platformRoles.map((r) => `\`${r}\``).join(", ") +
            ".",
    );
  }
  if (permissions.length > 0) paragraphs.push(permissionText(permissions));
  if (input.idempotency) paragraphs.push(idempotencyText(input.idempotency));

  /*
   * Built as a loose record and spread rather than written into the
   * literal below. `FastifySchema` names the keys @fastify/swagger
   * understands and has no index signature, so `"x-required-permission"`
   * in an object literal is an excess-property error even though the
   * plugin copies it through faithfully.
   */
  const extensions: Record<string, unknown> = {
    security: input.public ? [] : [{ [scheme]: [] }],
  };
  if (paragraphs.length > 0) extensions.description = paragraphs.join("\n\n");
  if (permissions.length > 0) {
    extensions["x-required-permission"] = permissions;
  }
  if (platformRoles.length > 0) {
    extensions["x-required-platform-role"] = platformRoles;
  }
  if (input.idempotency) {
    extensions["x-idempotency"] = {
      mode: input.idempotency.mode,
      /*
       * Not one route in this API REQUIRES a key. Emitted as a literal
       * `false` rather than omitted, because an absent "required" reads
       * as "unknown", and the whole point of documenting this is that a
       * caller who sends nothing gets a second payment rather than an
       * error telling them so.
       */
      required: false,
      ...(input.idempotency.field ? { field: input.idempotency.field } : {}),
      ...(input.idempotency.derivedFrom
        ? { derivedFrom: input.idempotency.derivedFrom }
        : {}),
    };
  }

  return {
    summary: input.summary,
    tags: input.tags,
    ...extensions,
    ...(input.body ? { body: jsonSchema(input.body) } : {}),
    ...(input.querystring
      ? { querystring: jsonSchema(input.querystring) }
      : {}),
    ...(input.params ? { params: jsonSchema(input.params) } : {}),
    ...(input.idempotency?.mode === "header"
      ? { headers: IDEMPOTENCY_HEADER }
      : {}),
    response: responses,
  };
}
