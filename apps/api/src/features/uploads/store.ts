/**
 * Writing an uploaded file to storage.
 *
 * Extracted from uploads.routes so the co-maker consent flow can reuse
 * it. A co-maker has no account — the invite token is their
 * authorization — so they can't call the authenticated upload
 * endpoint, but they must not get a second, laxer implementation of
 * where files land and which extensions are allowed.
 *
 * Since roadmap 3.1 the bytes go to a `StorageBackend` rather than
 * straight to the filesystem. On the default local-disk backend that is
 * the same `mkdir` + stream-to-file it always was, at the same path; the
 * seam exists so a bucket is a config change rather than a rewrite.
 */

import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import type { StorageBackend } from "@loan/storage";

import { uploadStorage, urlForKey } from "./backend";

/**
 * Mirrors `UploadSubdir` in libs/api-client/src/hooks/use-upload.ts.
 * Keep the two in sync — the client's union is the only thing stopping
 * a typo from reaching the 400.
 */
export const ALLOWED_SUBDIRS = new Set([
  "kyc",
  "selfies",
  "collateral",
  "misc",
  "signatures",
  "branding",
]);

export const ALLOWED_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
  ".heic",
]);

/**
 * SVG is allowed for the company logo only. BrandingPanel asks for it
 * (crisp at every size) and renders it through an `<img>`, where
 * script in the document can't execute. It stays off every other
 * subdir because `/uploads/` is served same-origin: navigating
 * directly to a stored `.svg` WOULD execute it, which turns a
 * borrower-writable subdir like `kyc` into a stored-XSS vector.
 */
export const SVG_SUBDIRS = new Set(["branding"]);

export type StoreResult =
  | { ok: true; url: string; filename: string; mimetype: string }
  | { ok: false; code: 400 | 413; message: string };

/**
 * Where the bytes go.
 *
 * A `StorageBackend` is what this really wants, and what the tests
 * inject. A plain string is the legacy form and means "the configured
 * backend" — the co-maker consent route passes the uploads directory
 * it derived itself, which is the same directory the configured local
 * backend is already rooted at, so the two agree by construction. It
 * matters that a string does NOT build a bare local adapter: that would
 * leave one caller writing to disk while the other wrote to a bucket.
 */
export type StoreTarget = StorageBackend | string;

function backendFor(target: StoreTarget | undefined): StorageBackend {
  return typeof target === "object" ? target : uploadStorage();
}

export async function storeUpload(
  file: MultipartFile,
  subdir: string,
  target?: StoreTarget,
): Promise<StoreResult> {
  if (!ALLOWED_SUBDIRS.has(subdir)) {
    return { ok: false, code: 400, message: "Unknown upload subdir" };
  }

  const ext = extname(file.filename).toLowerCase();
  const extOk =
    ALLOWED_EXT.has(ext) || (ext === ".svg" && SVG_SUBDIRS.has(subdir));
  if (!extOk) {
    return {
      ok: false,
      code: 400,
      message: `Unsupported file extension: ${ext || "(none)"}`,
    };
  }

  const storage = backendFor(target);
  const filename = `${randomUUID()}${ext}`;
  // Both halves are allowlisted — `subdir` against ALLOWED_SUBDIRS and
  // the extension against ALLOWED_EXT — so this key cannot carry a
  // traversal. The backend re-checks anyway; see @loan/storage/key.
  const key = `${subdir}/${filename}`;
  await storage.put(key, file.file, { contentType: file.mimetype });

  // @fastify/multipart stops the stream at the size limit rather than
  // throwing, so the partial object is already stored here. Remove it —
  // the caller gets a 413 and never learns the URL, so leaving it
  // would just accumulate unreachable bytes.
  if (file.file.truncated) {
    await storage.delete(key).catch(() => {});
    return { ok: false, code: 413, message: "File exceeds 5 MB" };
  }

  return {
    ok: true,
    url: urlForKey(key),
    filename,
    mimetype: file.mimetype,
  };
}
