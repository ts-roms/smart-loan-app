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

import { uploadStorage } from "./backend";
import { isProtectedUploadPath, signUploadPath } from "./signing";
import { storeUpload } from "./store";

export async function uploadRoutes(app: FastifyInstance) {
  const storage = uploadStorage(app.log);

  // No `resolveTenant`: nothing here touches Prisma. Uploads share one
  // namespace across tenants — safe because names are UUIDs, and the
  // static server is unauthenticated anyway so a per-tenant prefix
  // would add no isolation, only a URL shape change that existing rows
  // wouldn't match.
  app.addHook("preHandler", app.authenticate);

  app.post<{ Params: { subdir: string } }>("/:subdir", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "BadRequest", message: "No file" });
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
  });

  /**
   * Mint a time-limited URL for a stored upload.
   *
   * A POST rather than a GET because the path travels in the body:
   * a KYC filename in a query string ends up in access logs and
   * browser history, which is the leak this endpoint exists to close.
   *
   * Authenticated (the preHandler above) but not permission-gated, for
   * the same reason uploading isn't — see the module comment, and
   * signing.ts for what this does and doesn't scope.
   */
  app.post<{ Body: { url?: unknown } }>("/sign", async (req, reply) => {
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
  });
}
