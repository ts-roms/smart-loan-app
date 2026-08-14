/**
 * Compliance reports — the audit requirements across modules.
 *
 *   GET /reports/:type?from=&to=&format=json|csv
 *
 * Phase 2: per-request service wiring via `req.reportsServices`.
 */

import { endOfDay, startOfDay } from "@loan/accounting";
import {
  AccountingRepository,
  AuditLogRepository,
  CollectionsRepository,
  DorsiRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { validationError } from "../../lib/validation-error";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import {
  productProfitabilityQuerySchema,
  productProfitabilityResponseSchema,
  rollRateQuerySchema,
  rollRateResponseSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    reportsServices?: {
      reports: ReportsService;
      audit: AuditLogRepository;
      accounting: AccountingRepository;
    };
  }
}

const DAY_MS = 86_400_000;

/**
 * Date parsing for the roll-rate route, the same contract as
 * `parseAsOf`/`parseFrom` in accounting.routes.ts: date-only
 * "2026-07-01" widens to local start/end of day, a full timestamp is
 * taken as-is, and garbage answers the house 400 naming the parameter
 * rather than a 500 (the 80f1ccf fix, applied here from the start).
 */
function parseDateParam(
  value: string | undefined,
  param: string,
  widen: (v: string | Date) => Date,
): Date | undefined {
  if (!value) return undefined;
  const d = widen(value);
  if (Number.isNaN(d.getTime())) {
    throw validationError([
      {
        path: [param],
        message: 'Expected a date: "YYYY-MM-DD" or an ISO 8601 timestamp.',
        in: "querystring",
      },
    ]);
  }
  return d;
}

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.reportsServices = {
      reports: new ReportsService(
        prisma,
        new DorsiRepository(prisma),
        new CollectionsRepository(prisma),
      ),
      // Built with the caller so an impersonated session stamps the
      // platform operator behind it — see AuditLogRepository.
      audit: new AuditLogRepository(prisma, req.user?.impersonatedBy),
      // The roll-rate matrix lives beside the aging query it mirrors.
      accounting: new AccountingRepository(prisma),
    };
  });

  const ctrl = new ReportsController();

  /*
   * Roll-rate analysis (§30). A static route, so it wins over `/:type`
   * regardless of registration order; a dedicated one, because its
   * payload is a transition MATRIX rather than the flat rows the CSV
   * dispatcher below serializes.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/roll-rate",
    {
      preHandler: app.requirePermission("reports.read"),
      schema: routeSchema({
        summary:
          "Roll-rate matrix — how delinquency moved between aging bands " +
          "from `from` to `to`. Defaults to the last 30 days.",
        tags: ["reports"],
        querystring: rollRateQuerySchema,
        response: rollRateResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req) => {
      const to = parseDateParam(req.query.to, "to", endOfDay) ?? new Date();
      const from =
        parseDateParam(req.query.from, "from", startOfDay) ??
        new Date(to.getTime() - 30 * DAY_MS);
      if (from.getTime() >= to.getTime()) {
        throw validationError([
          {
            path: ["from"],
            message: "`from` must be earlier than `to`.",
            in: "querystring",
          },
        ]);
      }

      const report = await req.reportsServices!.accounting.rollRate(from, to);

      // Same audit trail as the other report reads: the run, its
      // parameters, and what it returned.
      await req.reportsServices!.audit.record({
        action: "REPORT_GENERATED",
        actorId: req.user.sub,
        targetType: "Report",
        targetId: "roll-rate",
        payload: {
          reportType: "roll-rate",
          format: "json",
          from: from.toISOString(),
          to: to.toISOString(),
          rowCount: report.totalLoans,
        },
      });

      return report;
    },
  );

  /*
   * Product profitability (§54). Static route for the same reasons as
   * roll-rate: it wins over `/:type`, and its payload — per-product
   * figures with exact-decimal money strings — is not the flat CSV rows
   * the dispatcher below serializes.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/product-profitability",
    {
      preHandler: app.requirePermission("reports.read"),
      schema: routeSchema({
        summary:
          "Product profitability — per loan product over the period: " +
          "interest, fee and late-fee income, write-off losses, and net. " +
          "Money figures are exact decimal strings. Defaults to the last " +
          "30 days.",
        tags: ["reports"],
        querystring: productProfitabilityQuerySchema,
        response: productProfitabilityResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req) => {
      const to = parseDateParam(req.query.to, "to", endOfDay) ?? new Date();
      const from =
        parseDateParam(req.query.from, "from", startOfDay) ??
        new Date(to.getTime() - 30 * DAY_MS);
      if (from.getTime() >= to.getTime()) {
        throw validationError([
          {
            path: ["from"],
            message: "`from` must be earlier than `to`.",
            in: "querystring",
          },
        ]);
      }

      const report = await req.reportsServices!.accounting.productProfitability(
        from,
        to,
      );

      await req.reportsServices!.audit.record({
        action: "REPORT_GENERATED",
        actorId: req.user.sub,
        targetType: "Report",
        targetId: "product-profitability",
        payload: {
          reportType: "product-profitability",
          format: "json",
          from: from.toISOString(),
          to: to.toISOString(),
          rowCount: report.products.length,
        },
      });

      return report;
    },
  );

  /*
   * No schema on the dispatcher, and unlike its two siblings above that
   * is not an omission.
   *
   * `/:type` serves every compliance report through one handler, and
   * the row shape differs per type — the CSV serializer below it takes
   * the UNION of all keys precisely because "rows may have different
   * shape". There is no single object to describe. The only schema that
   * would fit all of them is `z.array(z.record(z.unknown()))`, which
   * publishes "an array of objects" and stops: exactly the schema
   * written to hit a coverage target that openapi.coverage.test.ts
   * warns about in its header.
   *
   * `?format=csv` also streams `text/csv`, though on its own that would
   * not have been disqualifying — `/customers/:id/ledger` documents its
   * JSON shape and notes the CSV variant in the summary. The difference
   * there is that the ledger HAS one shape.
   *
   * `/roll-rate` and `/product-profitability` are documented above for
   * the same reason inverted: each has exactly one payload, which is
   * why they were pulled out as static routes to begin with.
   *
   * Recorded in the UNDESCRIBED list in openapi.coverage.test.ts, which
   * asserts the count so this cannot quietly become two.
   */
  app.get<{ Params: { type: string } }>(
    "/:type",
    { preHandler: app.requirePermission("reports.read") },
    ctrl.generate,
  );
}
