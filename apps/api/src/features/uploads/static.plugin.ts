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

  await app.register(staticPlugin, {
    root: opts.root,
    prefix: "/uploads/",
    decorateReply: false,
  });
}
