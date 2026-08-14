import type { FastifyReply } from "fastify";

import { keyFromUrl, uploadStorage } from "../uploads/backend";

/**
 * Document helpers. Stored-signature read + PDF streaming response
 * shape. Both used by the service and the controller, kept as
 * standalone functions because they're stateless and don't carry deps.
 */

/**
 * Resolve a stored signature URL (e.g. `/uploads/signatures/xxx.png`)
 * to a storage key and return the bytes. Returns null on any failure —
 * the renderer falls back to a blank signature line, which matches the
 * experience of "no signature on file."
 *
 * Path traversal is rejected by `keyFromUrl`, which applies the same
 * key validator the storage backends do. This used to hold its own
 * `..`-substring check against its own copy of `UPLOADS_DIR`, read
 * straight from `process.env` rather than from `config` — one rule in
 * one place now, and the read follows whichever backend is configured
 * rather than always hitting local disk.
 */
export async function loadSignature(
  url: string | null | undefined,
): Promise<Buffer | null> {
  const key = keyFromUrl(url);
  if (key === null) return null;
  try {
    return await uploadStorage().get(key);
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
