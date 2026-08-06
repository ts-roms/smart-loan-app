import type { FastifyReply, FastifyRequest } from "fastify";

import { portalPreAssessmentSchema } from "../pre-assessment/index";

import { clientIp, parseScope, toCsv, type LedgerScope } from "./helpers";
import {
  applySchema,
  intentSchema,
  kycSubmitSchema,
  ledgerQuerySchema,
  portalDeclarationAnswersSchema,
  profileUpdateSchema,
  signSchema,
} from "./schemas";

/**
 * HTTP adapter for the borrower portal. Phase 2: stateless. Reads
 * `req.portalServices.portal` per call.
 */
export class PortalController {
  // ─── /me ──────────────────────────────────────────────────────────

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await req.portalServices!.portal.getMe(auth);
    if (!result.ok) {
      return reply
        .code(404)
        .send({ error: "NotFound", message: "Customer record missing." });
    }
    return result.value;
  };

  updateProfile = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = profileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.portalServices!.portal.updateProfile(
      auth,
      parsed.data,
    );
    // The phone rule needs the stored number to know whether this is a
    // change, so it runs in the service — see updateProfile.
    if ("error" in result) return reply.code(400).send(result);
    return result;
  };

  // ─── loans ────────────────────────────────────────────────────────

  listLoans = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    return req.portalServices!.portal.listLoans(auth);
  };

  getLoan = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await req.portalServices!.portal.getLoan(
      auth,
      req.params.id,
    );
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.value;
  };

  signBorrower = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = signSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "signatureUrl required" });
    }
    const ip = clientIp(req.headers, req.ip);
    const result = await req.portalServices!.portal.signBorrower({
      customerId: auth,
      loanId: req.params.id,
      signatureUrl: parsed.data.signatureUrl,
      ip,
    });
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.value;
  };

  applyLoan = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.portalServices!.portal.applyLoan({
      customerId: auth,
      userId: req.user.sub,
      input: parsed.data,
    });
    if (!result.ok) {
      if (result.kind === "HasLiveLoan") {
        // 409, not 400: the request is well-formed and the refusal is
        // about the borrower's position, not their payload.
        return reply.code(409).send({
          error: "HasLiveLoan",
          message: result.message,
          liveLoans: result.liveLoans,
        });
      }
      return reply.code(400).send({
        error: "BadRequest",
        message: result.message,
        issues: result.issues,
      });
    }
    return reply.code(201).send(result.loan);
  };

  answerDeclarations = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = portalDeclarationAnswersSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.portalServices!.portal.answerDeclarations({
      customerId: auth,
      userId: req.user.sub,
      loanIdOrNumber: req.params.id,
      answers: parsed.data.answers,
    });
    if (result.ok) return result.declarations;
    switch (result.kind) {
      case "NotFound":
        return reply.code(404).send({ error: "NotFound" });
      case "NotEditable":
        return reply.code(409).send({
          error: "NotEditable",
          message:
            "Declarations can no longer be changed — the application has been decided.",
        });
      case "NoQuestionnaire":
        return reply.code(404).send({ error: "NoQuestionnaire" });
      case "InvalidAnswers":
        return reply
          .code(400)
          .send({ error: "InvalidAnswers", issues: result.invalid });
    }
  };

  // ─── pre-assessment ───────────────────────────────────────────────

  preAssess = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = portalPreAssessmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.portalServices!.portal.preAssess({
      customerId: auth,
      userId: req.user.sub,
      input: parsed.data,
    });
    // The guard already proved the customer row exists, so the service's
    // CustomerNotFound arm is only reachable if it was deleted mid-request.
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return reply.code(201).send(result.assessment);
  };

  listPreAssessments = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    return req.portalServices!.portal.listPreAssessments(auth);
  };

  // ─── KYC ─────────────────────────────────────────────────────────

  listKyc = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    return req.portalServices!.portal.listKyc(auth);
  };

  submitKyc = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = kycSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await req.portalServices!.portal.submitKyc({
        customerId: auth,
        userId: req.user.sub,
        input: parsed.data,
      }),
    );
  };

  // ─── payments ─────────────────────────────────────────────────────

  createIntent = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.portalServices!.portal.createIntent({
      customerId: auth,
      userId: req.user.sub,
      input: parsed.data,
    });
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return reply.code(201).send(result.value);
  };

  getIntent = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await req.portalServices!.portal.getIntent(
      auth,
      req.params.id,
    );
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.value;
  };

  // ─── ledgers ──────────────────────────────────────────────────────

  memberLedger = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await req.portalServices!.portal.memberLedger(auth);
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.value;
  };

  customerLedger = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = ledgerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const { from, to, scope } = this.ledgerOpts(parsed.data);
    const data = await req.portalServices!.portal.customerLedger(auth, {
      from,
      to,
      scope,
    });
    if (parsed.data.format === "csv") {
      // Reuses the same CSV shape as the staff `/customers/:id/ledger`
      // endpoint. Inlined because lifting the helper into @loan/db just
      // to share it would be over-engineered for one writer.
      const header = [
        "Date",
        "Kind",
        "Description",
        "Loan",
        "Direction",
        "Amount",
        "Balance",
        "Reference",
        "Notes",
      ];
      const rows = data.entries.map((e) => [
        e.date,
        e.kind,
        e.description,
        e.loanNumber ?? "",
        e.direction,
        e.amount.toFixed(2),
        e.runningBalance.toFixed(2),
        e.ref ?? "",
        e.notes ?? "",
      ]);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="my-statement.csv"`,
      );
      return reply.send(toCsv(header, rows));
    }
    return data;
  };

  customerLedgerPdf = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const parsed = ledgerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const buf = await req.portalServices!.portal.customerLedgerPdf(
      auth,
      this.ledgerOpts(parsed.data),
    );
    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="my-statement.pdf"`,
    );
    return reply.send(buf);
  };

  // ─── cooperative history ──────────────────────────────────────────

  contributions = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const format =
      (req.query as { format?: string } | undefined)?.format ?? "json";
    const rows = await req.portalServices!.portal.listContributions(auth);
    if (format === "csv") {
      const csv = toCsv(
        [
          "Date",
          "Capital Build-Up",
          "Mortuary Fund",
          "Emergency Fund",
          "Notes",
        ],
        rows.map((r) => [
          new Date(r.contributedAt).toISOString().slice(0, 10),
          r.capitalBuildUp.toString(),
          r.mortuaryFund.toString(),
          r.emergencyFund.toString(),
          r.notes ?? "",
        ]),
      );
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="contributions-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return csv;
    }
    return rows;
  };

  savings = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const format =
      (req.query as { format?: string } | undefined)?.format ?? "json";
    const rows = await req.portalServices!.portal.listSavings(auth);
    if (format === "csv") {
      const csv = toCsv(
        ["Date", "Kind", "Amount", "Notes"],
        rows.map((r) => [
          new Date(r.txnDate).toISOString().slice(0, 10),
          r.kind,
          r.amount.toString(),
          r.notes ?? "",
        ]),
      );
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="savings-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return csv;
    }
    return rows;
  };

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Resolve the calling user → customer id, or send the 403 directly
   * and return null. Callers `if (!auth) return;` to bail with one
   * line. Returning the resolved id (not the whole result union) keeps
   * the downstream code from having to re-destructure.
   */
  private async guard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> {
    const result = await req.portalServices!.portal.resolveCustomerId(
      req.user.sub,
    );
    if (!result.ok) {
      reply.code(403).send({ error: "Forbidden", message: result.message });
      return null;
    }
    return result.customerId;
  }

  private ledgerOpts(query: { from?: string; to?: string; scope?: string }): {
    from?: Date;
    to?: Date;
    scope: LedgerScope;
  } {
    return {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      scope: parseScope(query.scope),
    };
  }
}
