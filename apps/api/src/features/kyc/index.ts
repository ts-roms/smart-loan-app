import { KycRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { KycController } from "./kyc.controller";
import { registerKycHttp } from "./kyc.routes";
import { KycService } from "./kyc.service";

declare module "fastify" {
  interface FastifyRequest {
    kycServices?: { kyc: KycService };
  }
}

/**
 * KYC feature entry point — registered by the central router under
 * the `/kyc` prefix.
 *
 * Phase 2: per-request service wiring via `req.kycServices`. The
 * controller is a stateless singleton; the service tree is built
 * fresh per request against `req.tenantCtx.prisma`.
 */
export async function kycRoutes(app: FastifyInstance): Promise<void> {
  /*
   * `onRequest`, not `preHandler` — see the note in kyc.routes.ts.
   * Fastify validates the request between the two, so authenticating at
   * `preHandler` would let an anonymous caller with a malformed body
   * get a 400 describing the schema instead of the 401 they earned.
   * `resolveTenant` stays at `preHandler`: it reads the JWT claim this
   * hook verifies, so it must run after it, and it never rejects a
   * request for its shape.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const repo = new KycRepository(req.tenantCtx.prisma);
    req.kycServices = { kyc: new KycService(repo) };
  });

  const controller = new KycController();
  registerKycHttp(app, controller);
}
