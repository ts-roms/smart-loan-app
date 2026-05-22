import type { FastifyReply, FastifyRequest } from "fastify";

import { clientIp, parseScope, toCsv, type LedgerScope } from "./helpers";
import type { PortalService } from "./portal.service";
import {
  applySchema,
  intentSchema,
  kycSubmitSchema,
  ledgerQuerySchema,
  profileUpdateSchema,
  signSchema,
} from "./schemas";

/**
 * HTTP adapter for the borrower portal. Every endpoint follows the
 * same opening move: resolve the calling user → customerId; if that
 * fails, return 403. Then dispatch to the service with the resolved
 * customerId so ownership scoping is a typed argument.
 *
 * The format-dispatch endpoints (`/me/ledger`, `/contributions`,
 * `/savings`) handle JSON vs CSV here because the Content-Type +
 * Content-Disposition header writes are HTTP concerns.
 */
export class PortalController {
  constructor(private readonly service: PortalService) {}

  // ─── /me ──────────────────────────────────────────────────────────

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await this.service.getMe(auth);
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
    return this.service.updateProfile(auth, parsed.data);
  };

  // ─── loans ────────────────────────────────────────────────────────

  listLoans = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    return this.service.listLoans(auth);
  };

  getLoan = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await this.service.getLoan(auth, req.params.id);
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
    const ip = clientIp(req.headers as Record<string, unknown>, req.ip);
    const result = await this.service.signBorrower({
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
    const result = await this.service.applyLoan({
      customerId: auth,
      userId: req.user.sub,
      input: parsed.data,
    });
    if (!result.ok) {
      return reply.code(400).send({
        error: "BadRequest",
        message: result.message,
        issues: result.issues,
      });
    }
    return reply.code(201).send(result.loan);
  };

  // ─── KYC ─────────────────────────────────────────────────────────

  listKyc = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    return this.service.listKyc(auth);
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
      await this.service.submitKyc({
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
    const result = await this.service.createIntent({
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
    const result = await this.service.getIntent(auth, req.params.id);
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.value;
  };

  // ─── ledgers ──────────────────────────────────────────────────────

  memberLedger = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await this.guard(req, reply);
    if (!auth) return;
    const result = await this.service.memberLedger(auth);
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
    const data = await this.service.customerLedger(auth, { from, to, scope });
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
    const buf = await this.service.customerLedgerPdf(
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
    const rows = await this.service.listContributions(auth);
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
    const rows = await this.service.listSavings(auth);
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
    const result = await this.service.resolveCustomerId(req.user.sub);
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
