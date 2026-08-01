/**
 * Generic multipart file upload — `POST /uploads-api/:subdir`.
 *
 * Saves the file to `UPLOADS_DIR/<subdir>/<uuid><ext>` and returns the
 * public URL (`/uploads/<subdir>/<uuid><ext>`), which `app.ts` serves
 * via `@fastify/static`. Callers store that URL on whatever row it
 * belongs to — KycSubmission, LoanApplication.selfieUrl,
 * User.defaultSignatureUrl, SystemConfig.companyLogoUrl.
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
 *   • `/uploads/` is served statically with no auth (see app.ts), so
 *     the UUID filename is the only thing protecting a stored KYC
 *     document from being read by URL. That predates this module; it's
 *     called out here because this is where the filenames are minted.
 *
 * Size is capped at 5 MB by the `@fastify/multipart` registration in
 * app.ts. A file that trips the cap is deleted rather than left on
 * disk as an orphan.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { FastifyInstance } from "fastify";

import { config } from "../../config";

/**
 * Mirrors `UploadSubdir` in libs/api-client/src/hooks/use-upload.ts.
 * Keep the two in sync — the client's union is the only thing stopping
 * a typo from reaching the 400 below.
 */
const ALLOWED_SUBDIRS = new Set([
  "kyc",
  "selfies",
  "collateral",
  "misc",
  "signatures",
  "branding",
]);

const ALLOWED_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
  ".heic",
]);

/**
 * SVG is allowed for the company logo only. BrandingPanel asks for it
 * (crisp at every size) and renders it through an `<img>`, where script
 * in the document can't execute. It stays off every other subdir
 * because `/uploads/` is served same-origin: navigating directly to a
 * stored `.svg` WOULD execute it, which turns a borrower-writable
 * subdir like `kyc` into a stored-XSS vector.
 */
const SVG_SUBDIRS = new Set(["branding"]);

export async function uploadRoutes(app: FastifyInstance) {
  const baseDir = config.uploadsDir || join(process.cwd(), "uploads");

  // No `resolveTenant`: nothing here touches Prisma. Uploads share one
  // filesystem across tenants — safe because names are UUIDs, and the
  // static server is unauthenticated anyway so a per-tenant directory
  // would add no isolation, only a URL shape change that existing rows
  // wouldn't match.
  app.addHook("preHandler", app.authenticate);

  app.post<{ Params: { subdir: string } }>("/:subdir", async (req, reply) => {
    const { subdir } = req.params;
    if (!ALLOWED_SUBDIRS.has(subdir)) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "Unknown upload subdir" });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "BadRequest", message: "No file" });
    }

    const ext = extname(file.filename).toLowerCase();
    const extOk =
      ALLOWED_EXT.has(ext) || (ext === ".svg" && SVG_SUBDIRS.has(subdir));
    if (!extOk) {
      return reply.code(400).send({
        error: "BadRequest",
        message: `Unsupported file extension: ${ext || "(none)"}`,
      });
    }

    const targetDir = join(baseDir, subdir);
    await mkdir(targetDir, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    const fpath = join(targetDir, filename);
    await pipeline(file.file, createWriteStream(fpath));

    // @fastify/multipart stops the stream at the size limit rather than
    // throwing, so the partial file is already on disk here. Remove it
    // — the caller gets a 413 and never learns the URL, so leaving it
    // would just accumulate unreachable bytes.
    if (file.file.truncated) {
      await unlink(fpath).catch(() => {});
      return reply
        .code(413)
        .send({ error: "TooLarge", message: "File exceeds 5 MB" });
    }

    return reply.code(201).send({
      url: `/uploads/${subdir}/${filename}`,
      filename,
      mimetype: file.mimetype,
    });
  });
}
