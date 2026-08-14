import type { FastifyReply, FastifyRequest } from "fastify";

import { retentionPolicyUpdateSchema } from "./retention.schemas";
import {
  documentPurgeRequestSchema,
  eraseRequestSchema,
  exportRequestSchema,
} from "./schemas";

/**
 * HTTP adapter for /compliance/*. Stateless — reads the service from
 * `req.complianceServices.compliance`.
 *
 * Both endpoints accept a customer id in the URL and a small JSON
 * body. The export response is a large JSON blob streamed as a file
 * download (Content-Disposition: attachment) because that's how
 * DSAR responses are typically transmitted to the data subject.
 */
export class ComplianceController {
  /**
   * GET-like operation, but uses POST because:
   *   - The body carries the audit reason ("ticket #1234").
   *   - The action is non-idempotent (writes an audit row).
   *   - Plain GET would let an admin's browser fetch the export by
   *     accident from history; POST forces an explicit action.
   */
  exportCustomer = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = exportRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.complianceServices!.compliance.exportCustomer({
      customerId: req.params.id,
      actorId: req.user.sub,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      return reply
        .code(404)
        .send({ error: result.kind, message: result.message });
    }
    // Stream as a downloadable JSON file. The filename includes the
    // customer id + a generation timestamp so the data subject can
    // verify they received the right blob.
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="dsar-${req.params.id}-${result.generatedAt.replace(/[:.]/g, "-")}.json"`,
    );
    return result;
  };

  /**
   * POST /compliance/customers/:id/erase — irreversible PII redaction.
   *
   * Three failure modes map to distinct HTTP codes so the UI can show
   * specific errors:
   *
   *   - AcknowledgmentRequired → 400 (operator missed the checkbox)
   *   - NotFound               → 404
   *   - AlreadyErased          → 409 (idempotency: don't double-erase)
   */
  eraseCustomer = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = eraseRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.complianceServices!.compliance.eraseCustomer({
      customerId: req.params.id,
      actorId: req.user.sub,
      reason: parsed.data.reason,
      acknowledgesRetention: parsed.data.acknowledgesRetention,
    });
    if (!result.ok) {
      const code =
        result.kind === "NotFound"
          ? 404
          : result.kind === "AlreadyErased"
            ? 409
            : 400; // AcknowledgmentRequired
      return reply
        .code(code)
        .send({ error: result.kind, message: result.message });
    }
    return result;
  };

  // ─── retention policy ───────────────────────────────────────────────

  /** GET — admin-readable; surfaces the AMLA-floor warning flag too. */
  getRetentionPolicy = async (req: FastifyRequest) => {
    return req.complianceServices!.retention.getPolicy();
  };

  /**
   * PUT — admin updates the days-per-table knobs. Audited.
   *
   * The floor rejection answers 400 with `error: "BelowRegulatoryFloor"`
   * rather than the 422 it deserves. 422 is the honest status — the body
   * is well-formed and in range, so this is a semantically valid request
   * the platform refuses, not a malformed one — but the shared error
   * table in lib/openapi.ts does not carry 422, and widening it is the
   * OpenAPI branch's call, not this one's. The discriminator is
   * therefore the `error` field: a UI tells a typo from a policy refusal
   * by reading it, not by status. Worth revisiting when 422 lands.
   */
  updateRetentionPolicy = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = retentionPolicyUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.complianceServices!.retention.updatePolicy({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply.code(400).send({
        error: result.kind,
        message: result.message,
        floorDays: result.floorDays,
        requestedDays: result.requestedDays,
      });
    }
    return result.policy;
  };

  /**
   * POST /compliance/customers/:id/documents-purge — delete the
   * uploaded KYC documents and application selfies behind a customer,
   * keeping every header row.
   *
   * `dryRun: true` (the default in the schema) reports what a real run
   * would remove and touches nothing, which is the §46 preview step.
   * Safe to re-run either way.
   */
  purgeCustomerDocuments = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = documentPurgeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.complianceServices!.compliance.purgeDocuments({
      customerId: req.params.id,
      actorId: req.user.sub,
      reason: parsed.data.reason,
      dryRun: parsed.data.dryRun,
    });
    if (!result.ok) {
      return reply
        .code(404)
        .send({ error: result.kind, message: result.message });
    }
    return result;
  };

  /**
   * Manual "run now" trigger. Useful right after lowering the
   * retention values — the scheduled tick only fires nightly, and an
   * operator who just slashed the audit window from 5y to 2y usually
   * wants the deletes to land immediately.
   */
  runRetentionPurge = async (req: FastifyRequest) => {
    return req.complianceServices!.retention.runPurge({
      actorId: req.user.sub,
    });
  };
}
