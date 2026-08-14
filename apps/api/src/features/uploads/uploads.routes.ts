/**
 * Generic multipart file upload — `POST /uploads-api/:subdir`.
 *
 * Saves the file at storage key `<subdir>/<uuid><ext>` and returns the
 * public URL (`/uploads/<subdir>/<uuid><ext>`), which `app.ts` serves
 * through the configured storage backend. Callers store that URL on
 * whatever row it belongs to — KycSubmission, LoanApplication.selfieUrl,
 * User.defaultSignatureUrl, SystemConfig.companyLogoUrl.
 *
 * The URL is the key plus a `/uploads/` prefix, which is what lets the
 * backend change without migrating a single database row.
 *
 * ## Authorization
 *
 * Any authenticated user, deliberately. Uploading is inert on its own:
 * the returned URL is an unguessable UUID and nothing references it
 * until a *separate*, gated request stores it. Borrowers legitimately
 * upload here (PortalKyc posts to `kyc`), officers post signatures, and
 * admins post a branding logo — but applying any of those is the
 * consuming endpoint's decision, gated by its own permission
 * (`kyc.submit`, `loans.sign_officer`, `admin.system_config`). Putting
 * a permission on the upload itself would just be a second, weaker
 * copy of those checks.
 *
 * Two properties this relies on, both worth knowing:
 *
 *   • `:subdir` is allowlisted, and the stored extension can only ever
 *     be one of the literal strings in ALLOWED_EXT — so neither can
 *     carry a `..` traversal into the join().
 *   • `/uploads/` is served statically, but protected subdirs now
 *     require a signature minted by `POST /uploads-api/sign` (see
 *     signing.ts). The UUID filename is no longer the only thing
 *     standing between a stored KYC document and the public internet.
 *
 * Size is capped at 5 MB by the `@fastify/multipart` registration in
 * app.ts. A file that trips the cap is deleted rather than left on
 * disk as an orphan.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";
import { uploadStorage } from "./backend";
import { isProtectedUploadPath, signUploadPath } from "./signing";
import { storeUpload } from "./store";

const TAGS = ["uploads"];

/**
 * `:subdir` — documented, not constrained.
 *
 * `z.string()` rather than the `ALLOWED_SUBDIRS` enum on purpose.
 * `storeUpload` already rejects an unknown subdir with its own 400 and
 * its own message; encoding the allowlist here would move that
 * rejection into Fastify, change the body callers receive, and add a
 * second copy of the list that goes stale the first time store.ts gains
 * an entry. The values are named in the summary instead, where a reader
 * needs them and nothing depends on them.
 */
const subdirParamSchema = z.object({ subdir: z.string() });

/**
 * `POST /uploads-api/sign` body.
 *
 * Safe to attach even though the handler reads `req.body?.url`
 * defensively: a request with no body, or one whose `url` is not a
 * string, already answers 400 today (`raw` falls back to `""`, which
 * fails the `/uploads/` prefix check). The status is unchanged — only
 * the message moves from "Not an upload path" to the standard
 * validation body. This was checked against the running server rather
 * than assumed; see trap 4 in the batch notes.
 */
const signBodySchema = z.object({
  /** A `/uploads/...` path. An absolute URL is rejected. */
  url: z.string(),
});

/** What the signer hands back. */
const signResponseSchema = z.object({
  /** `<path>?exp=<ms>&sig=<hex>` when signed; the bare path when public. */
  url: z.string(),
  /**
   * Unix **milliseconds**, not an ISO string — the one field in this
   * feature that breaks the codebase's date convention, because it is
   * compared against `Date.now()` in the signature check rather than
   * displayed. Null for a public subdir, which needs no signature and
   * therefore never expires.
   */
  expiresAt: z.number().nullable(),
});

/** What a stored upload answers. */
const storeResponseSchema = z.object({
  /** `/uploads/<subdir>/<uuid><ext>` — store this, not the file. */
  url: z.string(),
  /** `<uuid><ext>`. NOT the client's original filename. */
  filename: z.string(),
  mimetype: z.string(),
});

export async function uploadRoutes(app: FastifyInstance) {
  const storage = uploadStorage(app.log);

  // No `resolveTenant`: nothing here touches Prisma. Uploads share one
  // namespace across tenants — safe because names are UUIDs, and the
  // static server is unauthenticated anyway so a per-tenant prefix
  // would add no isolation, only a URL shape change that existing rows
  // wouldn't match.
  //
  /*
   * ─── Auth posture: JWT, at `onRequest` ─────────────────────────────
   *
   * Worth stating precisely, because this feature owns two surfaces
   * with two different answers and they are easy to confuse:
   *
   *   • `/uploads-api/*` — THESE routes. Any authenticated user, via
   *     the bearer token. Not permission-gated; see the module comment.
   *   • `/uploads/*` — the static SERVING routes in static.plugin.ts.
   *     Those are not JWT-authenticated at all: a protected path is
   *     reached with an HMAC signature minted by `/uploads-api/sign`
   *     below, which is why that endpoint exists.
   *
   * The hook moved from `preHandler` to `onRequest` when `/sign` gained
   * a body schema. Fastify validates between the two, so at
   * `preHandler` an anonymous caller posting a malformed body would get
   * a 400 about the body rather than the 401 they earned.
   */
  app.addHook("onRequest", app.authenticate);

  /*
   * No `body` schema: this is a multipart upload read via `req.file()`.
   * Attaching a JSON body schema would make Fastify validate the
   * multipart stream as an object and reject every real request — the
   * same reason the co-maker upload route leaves its body undeclared.
   * `routeSchema` has no way to describe a file part.
   */
  app.post<{ Params: { subdir: string } }>(
    "/:subdir",
    {
      schema: routeSchema({
        summary:
          "Upload a file (multipart) and get back the URL to store on " +
          "whatever row it belongs to. `:subdir` is one of kyc, selfies, " +
          "collateral, misc, signatures, branding. Capped at 5 MB — 413 " +
          "over it. Any authenticated user: uploading is inert until a " +
          "separate, gated request references the URL.",
        tags: TAGS,
        params: subdirParamSchema,
        response: storeResponseSchema,
        status: 201,
        errors: [400, 401, 413],
      }),
    },
    async (req, reply) => {
      const file = await req.file();
      if (!file) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "No file" });
      }
      const result = await storeUpload(file, req.params.subdir, storage);
      if (!result.ok) {
        return reply.code(result.code).send({
          error: result.code === 413 ? "TooLarge" : "BadRequest",
          message: result.message,
        });
      }
      return reply.code(201).send({
        url: result.url,
        filename: result.filename,
        mimetype: result.mimetype,
      });
    },
  );

  /**
   * Mint a time-limited URL for a stored upload.
   *
   * A POST rather than a GET because the path travels in the body:
   * a KYC filename in a query string ends up in access logs and
   * browser history, which is the leak this endpoint exists to close.
   *
   * Authenticated (the `onRequest` hook above) but not
   * permission-gated, for the same reason uploading isn't — see the
   * module comment, and signing.ts for what this does and doesn't scope.
   */
  app.post<{ Body: { url?: unknown } }>(
    "/sign",
    {
      schema: routeSchema({
        summary:
          "Mint a time-limited signed URL for a stored upload. A POST " +
          "because the path travels in the body — a KYC filename in a " +
          "query string ends up in access logs, which is the leak this " +
          "closes. A public subdir (branding) answers the bare path " +
          "with `expiresAt: null`; everything else is signed.",
        tags: TAGS,
        body: signBodySchema,
        response: signResponseSchema,
        errors: [400, 401],
      }),
    },
    async (req, reply) => {
      const raw = typeof req.body?.url === "string" ? req.body.url : "";
      // Strip any existing query so a signature can't be re-signed into
      // the path, and reject anything that isn't a plain upload path —
      // an absolute URL here would let a caller mint a signature for
      // another origin's path shape.
      const pathname = raw.split("?")[0] ?? "";
      if (!pathname.startsWith("/uploads/") || pathname.includes("..")) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "Not an upload path" });
      }

      if (!isProtectedUploadPath(pathname)) {
        // Public subdirs need no signature; hand the path straight back
        // so callers don't have to know which is which.
        return { url: pathname, expiresAt: null };
      }

      return signUploadPath(pathname);
    },
  );
}
