import type { FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Document helpers. Filesystem signature read + PDF streaming response
 * shape. Both used by the service and the controller, kept as
 * standalone functions because they're stateless and don't carry deps.
 */

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), "uploads");

/**
 * Resolve a stored signature URL (e.g. `/uploads/signatures/xxx.png`)
 * to the filesystem path and return the bytes. Returns null on any
 * failure — the renderer falls back to a blank signature line, which
 * matches the experience of "no signature on file."
 *
 * Path traversal is rejected explicitly: anything containing `..` or
 * not starting with `/uploads/` is dropped.
 */
export async function loadSignature(
  url: string | null | undefined,
): Promise<Buffer | null> {
  if (!url) return null;
  const prefix = "/uploads/";
  if (!url.startsWith(prefix)) return null;
  const rel = url.slice(prefix.length);
  if (rel.includes("..")) return null;
  try {
    return await readFile(join(UPLOADS_DIR, rel));
  } catch {
    return null;
  }
}

/**
 * Write the PDF bytes back as `application/pdf` with `inline`
 * disposition so the browser previews it in a tab rather than
 * triggering a forced download. Filename hints the saved name when
 * the user does choose to download.
 */
export function sendPdf(
  reply: FastifyReply,
  buf: Buffer,
  filename: string,
): FastifyReply {
  return reply
    .header("Content-Type", "application/pdf")
    .header("Content-Disposition", `inline; filename="${filename}"`)
    .header("Content-Length", String(buf.byteLength))
    .send(buf);
}
