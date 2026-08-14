/**
 * Serves `/uploads/` behind the signature check.
 *
 * A plugin rather than inline registration in app.ts for two reasons:
 * the hook must be scoped so it can't leak onto unrelated routes, and
 * the gate is security code that has to be testable without standing
 * up a database-backed app.
 *
 * See signing.ts for why a query-string signature rather than Bearer
 * auth, and for what this does and doesn't scope.
 *
 * ## Why bytes still leave through the API after roadmap 3.1
 *
 * The obvious thing to do with an object store is to redirect the
 * browser at a bucket-signed URL and stop proxying bytes. This
 * deliberately does not, because both protections below are properties
 * of *this origin's response* and neither survives the redirect: the
 * bucket sets its own Content-Type, sends no CSP, and has never heard
 * of the HMAC gate. A KYC document is attacker-influenced bytes, so the
 * sandbox is not optional.
 *
 * The cost is that the API stays on the data path — it is a proxy, not
 * a redirector. For 5 MB documents rendered a dozen at a time on a
 * review screen that is an acceptable trade, and it keeps the security
 * posture identical across both backends.
 */

import staticPlugin from "@fastify/static";
import type { StorageBackend } from "@loan/storage";
import type { FastifyInstance } from "fastify";

import { keyFromUrl } from "./backend";
import { isProtectedUploadPath, verifyUploadSignature } from "./signing";

export interface UploadStaticOptions {
  /** Backend holding the stored files. */
  storage: StorageBackend;
}

/**
 * Content types for the closed set of extensions `store.ts` admits.
 *
 * Only consulted on the non-local path — `@fastify/static` does its own
 * inference, and changing that would be a behaviour change for every
 * deployment running today. Anything unrecognised is served as opaque
 * bytes rather than guessed at.
 */
const CONTENT_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".heic", "image/heic"],
  [".svg", "image/svg+xml"],
]);

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".");
  const ext = dot === -1 ? "" : key.slice(dot).toLowerCase();
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
}

export async function uploadStaticPlugin(
  app: FastifyInstance,
  opts: UploadStaticOptions,
) {
  app.addHook("onRequest", async (req, reply) => {
    const [pathname, query = ""] = req.url.split("?");
    if (!pathname || !isProtectedUploadPath(pathname)) return;

    const params = new URLSearchParams(query);
    const result = verifyUploadSignature(
      pathname,
      params.get("exp") ?? undefined,
      params.get("sig") ?? undefined,
    );
    if (result === "ok") return;

    // 401 on expiry, 403 otherwise. The client retries a 401 by
    // re-signing; a 403 means the signature was never valid and
    // retrying would only loop.
    req.log.warn({ pathname, result }, "rejected unsigned upload request");
    return reply.code(result === "expired" ? 401 : 403).send({
      error: result === "expired" ? "SignatureExpired" : "Forbidden",
    });
  });

  /*
   * Nothing served out of /uploads/ may execute.
   *
   * `store.ts` already keeps `.svg` out of every borrower-writable
   * subdir, and says why: uploads are served SAME-ORIGIN, so navigating
   * directly to a stored SVG runs any script inside it. That leaves
   * `branding`, where an admin can still plant one — a smaller hole,
   * but the same hole, and it is reachable by anyone who compromises an
   * admin session rather than only by an admin.
   *
   * `sandbox` is what closes it. A sandboxed response is its own opaque
   * origin with scripting off, so the file renders and cannot reach the
   * session that opened it. It applies to DIRECT NAVIGATION — the
   * vector — and not to `<img src>`, so the branding panel and every
   * document preview are unaffected.
   *
   * default-src 'none' on top of that stops a served document fetching
   * anything at all: no beacon, no exfiltration, nothing to see if a
   * file does contain something it should not.
   *
   * This hook is backend-independent by design: it runs on every
   * `/uploads/` response whether the bytes came from `@fastify/static`
   * or from a storage stream, so the two paths cannot drift apart.
   */
  app.addHook("onSend", async (req, reply) => {
    if (!req.url.startsWith("/uploads/")) return;
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    );
    // Belt and braces with the CSP: stops a .png whose bytes are HTML
    // from being re-interpreted as a document.
    reply.header("X-Content-Type-Options", "nosniff");
  });

  if (opts.storage.localRoot !== undefined) {
    // Local disk: hand off to @fastify/static exactly as before. It
    // brings Range requests, ETags and conditional GETs, and every
    // deployment running today is served by it — reimplementing that
    // over the storage interface would be a silent regression.
    await app.register(staticPlugin, {
      root: opts.storage.localRoot,
      prefix: "/uploads/",
      decorateReply: false,
    });
    return;
  }

  // Remote backend: stream the object through. Registered as a wildcard
  // GET rather than a plugin so it sits behind the same two hooks above.
  app.get<{ Params: { "*": string } }>("/uploads/*", async (req, reply) => {
    const key = keyFromUrl(req.url);
    if (key === null) {
      return reply.code(404).send({ error: "NotFound" });
    }
    const stream = await opts.storage.getStream(key);
    if (stream === null) {
      return reply.code(404).send({ error: "NotFound" });
    }
    return reply.type(contentTypeFor(key)).send(stream);
  });
}
