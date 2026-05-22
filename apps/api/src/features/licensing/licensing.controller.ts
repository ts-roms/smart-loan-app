import type { FastifyReply, FastifyRequest } from "fastify";

import { toStatusPayload } from "./licensing.service";
import { activateLicenseSchema } from "./schemas";

/**
 * HTTP adapter for the licensing routes. The service holds verify +
 * persist; this layer is pure request/response.
 *
 * Phase 2: stateless. Reads `req.licensingServices.licensing` per call
 * so each tenant operates on its own License row.
 */
export class LicensingController {
  /**
   * GET /license/status — current license shape, safe to expose to
   * any authenticated user. Doesn't leak the full token, just the
   * payload fields the UI needs to render the status panel.
   */
  status = async (req: FastifyRequest) => {
    const current = await req.licensingServices!.licensing.loadCurrent();
    return toStatusPayload(current);
  };

  /**
   * POST /license/activate — admin pastes a token. The service
   * verifies the signature + temporal bounds before persisting.
   */
  activate = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = activateLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.licensingServices!.licensing.activate({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      // VerifyFailed → 400 because the input is bad. NoKeyConfigured
      // is a server-state issue but still surfaces as 400 with a clear
      // message — the operator can act on it (set the env var, restart).
      // RepoError → 500.
      const code = result.kind === "RepoError" ? 500 : 400;
      return reply.code(code).send({
        error: result.kind,
        message: result.message,
      });
    }
    return toStatusPayload(result.status);
  };

  /**
   * POST /license/deactivate — admin clears the current license.
   * Always succeeds (no-op when nothing is active).
   */
  deactivate = async (req: FastifyRequest) => {
    return req.licensingServices!.licensing.deactivate({
      actorId: req.user.sub,
    });
  };
}
