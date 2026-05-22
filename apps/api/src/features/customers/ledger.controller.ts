import type { FastifyReply, FastifyRequest } from "fastify";

import { FAILED, ledgerToCsv, normalizeScope, parseDateOr400 } from "./helpers";
import type { LedgerQuery } from "./schemas";
import type { CustomerLedgerService } from "./ledger.service";

type LedgerReq = FastifyRequest<{
  Params: { id: string };
  Querystring: LedgerQuery;
}>;

/**
 * HTTP adapter for the customer ledger surface.
 *
 *   GET  /:id/ledger          → JSON, or `?format=csv` streams a CSV.
 *   GET  /:id/ledger.pdf      → PDF stream.
 *   POST /:id/ledger/email    → fire a STATEMENT_READY notification.
 */
export class CustomerLedgerController {
  constructor(private readonly service: CustomerLedgerService) {}

  json = async (req: LedgerReq, reply: FastifyReply) => {
    const scope = normalizeScope(req.query.scope);
    const from = parseDateOr400(req.query.from, reply);
    if (from === FAILED) return;
    const to = parseDateOr400(req.query.to, reply);
    if (to === FAILED) return;

    const result = await this.service.build(req.params.id, { from, to, scope });
    if (!result) return reply.code(404).send({ error: "NotFound" });

    if (req.query.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="statement-${result.customerNumber}.csv"`,
      );
      return reply.send(ledgerToCsv(result.ledger));
    }

    return result.ledger;
  };

  pdf = async (req: LedgerReq, reply: FastifyReply) => {
    const scope = normalizeScope(req.query.scope);
    const from = parseDateOr400(req.query.from, reply);
    if (from === FAILED) return;
    const to = parseDateOr400(req.query.to, reply);
    if (to === FAILED) return;

    const result = await this.service.build(req.params.id, { from, to, scope });
    if (!result) return reply.code(404).send({ error: "NotFound" });

    const buf = await this.service.renderPdf(result.ledger);
    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="statement-${result.customerNumber}.pdf"`,
    );
    return reply.send(buf);
  };

  email = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.dispatchStatementReady(req.params.id);
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return reply.code(202).send(result);
  };
}
