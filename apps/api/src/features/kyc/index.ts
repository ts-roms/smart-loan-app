import { KycRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { KycController } from "./kyc.controller";
import { registerKycHttp } from "./kyc.routes";
import { KycService } from "./kyc.service";

/**
 * KYC feature entry point — registered by the central router under
 * the `/kyc` prefix. Sets up the auth preHandler once for the whole
 * feature, then wires repo → service → controller → routes.
 */
export async function kycRoutes(app: FastifyInstance): Promise<void> {
  const repo = new KycRepository(app.prisma);
  const service = new KycService(repo);
  const controller = new KycController(service);

  app.addHook("preHandler", app.authenticate);

  registerKycHttp(app, controller);
}
