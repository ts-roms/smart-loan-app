/**
 * Compliance reports — FRD audit requirements (§3.1.5, §3.2.3, §3.3.7,
 * §3.5.8, §3.7.7, §3.8.6, §3.9.4, §3.10.6).
 *
 *   GET /reports/:type?from=&to=&format=json|csv
 *
 * Supported types (matched to FRD sections):
 *   - dorsi-utilization     §3.10.6   current snapshot + per-borrower
 *   - penalty-waivers       §3.3.7    date-range waivers
 *   - demand-letters        §3.6      date-range dispatched letters
 *   - repossession-cases    §3.7.7    date-range cases (any status)
 *   - annual-docs           §3.8.6    current compliance % by status
 *   - ecl-movement          §3.4.3    period-over-period delta from EclRun
 *
 * Layered: routes → controller (CSV/JSON + filename header) → service
 * (row-builder dispatch). Read-only; no audit row written for read
 * queries — generating a report is not a state change.
 */

import { DorsiRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

export async function reportRoutes(app: FastifyInstance) {
  const service = new ReportsService(
    app.prisma,
    new DorsiRepository(app.prisma),
  );
  const ctrl = new ReportsController(service);

  app.addHook("preHandler", app.authenticate);

  app.get<{ Params: { type: string } }>(
    "/:type",
    { preHandler: app.requirePermission("reports.read") },
    ctrl.generate,
  );
}
