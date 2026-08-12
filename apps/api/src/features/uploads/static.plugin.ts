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
 */

import staticPlugin from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { isProtectedUploadPath, verifyUploadSignature } from "./signing";

export interface UploadStaticOptions {
  /** Directory to serve. */
  root: string;
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

  await app.register(staticPlugin, {
    root: opts.root,
    prefix: "/uploads/",
    decorateReply: false,
  });
}
