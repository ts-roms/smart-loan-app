import type { FastifyError } from "fastify";

/**
 * One shape for "the request was wrong", in one place.
 *
 * Every controller in this codebase answers a bad request with
 * `{ error: "ValidationError", issues: [...] }`, the issues naming the
 * field at fault the way zod names it. Two places need that same body
 * without a zod parse to produce it for them:
 *
 *   • the schema error formatter in app.ts, for the requests Fastify
 *     itself rejects against a route's JSON Schema;
 *   • a handler validating something JSON Schema cannot express — a date
 *     parameter that must keep accepting the date-only "2026-08-07", for
 *     instance (see `parseAsOf` in accounting.routes.ts).
 *
 * They are the same failure to a caller and must not read differently,
 * which is the whole reason this is a factory and not two hand-rolled
 * literals a rename could quietly separate.
 *
 * The body travels ON the error rather than being sent directly, because
 * the second case happens inside a handler expression where the only
 * seam available is `throw`. Fastify renders a thrown error as
 * `{ statusCode, error, message }` — its shape, not this API's — so the
 * app's error handler looks for `validationBody` and sends that instead.
 * `statusCode` is set as well, so a mount that somehow lacks that
 * handler still answers 400 rather than 500: the status is the part a
 * client branches on.
 */
export interface ValidationIssue {
  /** Field path, zod-style: ["asOf"], ["lines", 0, "amount"]. */
  path: (string | number)[];
  message: string;
  /** Which part of the request failed: body, querystring, params. */
  in?: string;
}

export type ValidationError = FastifyError & { validationBody: unknown };

/** A throwable 400 carrying the house validation body. */
export function validationError(issues: ValidationIssue[]): ValidationError {
  const err = new Error("Validation failed") as ValidationError;
  err.statusCode = 400;
  err.validationBody = { error: "ValidationError", issues };
  return err;
}

/**
 * The body this error wants sent, or undefined if it is not one of ours.
 * Read by the app's error handler — see `setErrorHandler` in app.ts.
 */
export function validationBodyOf(err: unknown): unknown {
  return (err as { validationBody?: unknown } | null | undefined)
    ?.validationBody;
}
