/**
 * Writing an uploaded file to disk.
 *
 * Extracted from uploads.routes so the co-maker consent flow can reuse
 * it. A co-maker has no account — the invite token is their
 * authorization — so they can't call the authenticated upload
 * endpoint, but they must not get a second, laxer implementation of
 * where files land and which extensions are allowed.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { MultipartFile } from "@fastify/multipart";

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

export async function storeUpload(
  file: MultipartFile,
  subdir: string,
  baseDir: string,
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

  const targetDir = join(baseDir, subdir);
  await mkdir(targetDir, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  const fpath = join(targetDir, filename);
  await pipeline(file.file, createWriteStream(fpath));

  // @fastify/multipart stops the stream at the size limit rather than
  // throwing, so the partial file is already on disk here. Remove it —
  // the caller gets a 413 and never learns the URL, so leaving it
  // would just accumulate unreachable bytes.
  if (file.file.truncated) {
    await unlink(fpath).catch(() => {});
    return { ok: false, code: 413, message: "File exceeds 5 MB" };
  }

  return {
    ok: true,
    url: `/uploads/${subdir}/${filename}`,
    filename,
    mimetype: file.mimetype,
  };
}
