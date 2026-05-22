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
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const repo = new KycRepository(req.tenantCtx.prisma);
    req.kycServices = { kyc: new KycService(repo) };
  });

  const controller = new KycController();
  registerKycHttp(app, controller);
}
