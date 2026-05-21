/**
 * Compliance reports — FRD audit requirements (§3.1.5, §3.2.3, §3.3.7,
 * §3.5.8, §3.7.7, §3.8.6, §3.9.4, §3.10.6).
 *
 * Each FRD module ends with a "Conduct monthly/quarterly audits of …"
 * line. This route exposes those audit snapshots as JSON or CSV
 * downloadable rows, date-range filterable. The Reports UI page is a
 * thin wrapper that renders cards for each report type with download
 * buttons.
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
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { DorsiRepository } from "@loan/db";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get<{ Params: { type: string } }>(
    "/:type",
    { preHandler: app.requirePermission("reports.read") },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const from = parsed.data.from
        ? new Date(parsed.data.from)
        : oneMonthAgo();
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
      const { format } = parsed.data;

      switch (req.params.type) {
        case "dorsi-utilization": {
          const rows = await dorsiUtilizationRows(app);
          return send(reply, format, `dorsi-utilization-${stamp()}`, rows);
        }
        case "penalty-waivers": {
          const rows = await penaltyWaiverRows(app, from, to);
          return send(
            reply,
            format,
            `penalty-waivers-${stamp(from, to)}`,
            rows,
          );
        }
        case "demand-letters": {
          const rows = await demandLetterRows(app, from, to);
          return send(reply, format, `demand-letters-${stamp(from, to)}`, rows);
        }
        case "repossession-cases": {
          const rows = await repossessionRows(app, from, to);
          return send(
            reply,
            format,
            `repossession-cases-${stamp(from, to)}`,
            rows,
          );
        }
        case "annual-docs": {
          const rows = await annualDocRows(app);
          return send(reply, format, `annual-docs-${stamp()}`, rows);
        }
        case "ecl-movement": {
          const rows = await eclMovementRows(app, from, to);
          return send(reply, format, `ecl-movement-${stamp(from, to)}`, rows);
        }
        default:
          return reply
            .code(404)
            .send({
              error: "NotFound",
              message: `Unknown report type: ${req.params.type}`,
            });
      }
    },
  );
}

// ── Row builders ─────────────────────────────────────────────────────────

async function dorsiUtilizationRows(app: FastifyInstance) {
  const repo = new DorsiRepository(app.prisma);
  const u = await repo.utilization();
  return u.perBorrower.map((b) => ({
    customerId: b.customerId,
    customerName: b.customerName,
    category: b.category,
    outstanding: b.outstanding,
    individualCap: u.individualCap,
    utilizationPct: round4(b.utilizationPct),
    aggregateOutstanding: u.aggregateOutstanding,
    aggregateCap: u.aggregateCap,
    aggregateUtilizationPct: round4(u.aggregateUtilizationPct),
    companyTotalEquity: u.companyTotalEquity,
  }));
}

async function penaltyWaiverRows(app: FastifyInstance, from: Date, to: Date) {
  const rows = await app.prisma.penaltyWaiver.findMany({
    where: { waivedAt: { gte: from, lte: to } },
    include: {
      loan: { select: { number: true, customerId: true } },
      waivedBy: { select: { name: true, email: true } },
    },
    orderBy: { waivedAt: "desc" },
  });
  return rows.map((w) => ({
    waiverId: w.id,
    loanNumber: w.loan.number,
    customerId: w.loan.customerId,
    waivedAt: w.waivedAt.toISOString(),
    originalPenalty: Number(w.originalPenalty),
    waivedAmount: Number(w.waivedAmount),
    negotiatedPenalty: Number(w.negotiatedPenalty),
    reason: w.reason,
    waivedBy: w.waivedBy.name,
    waivedByEmail: w.waivedBy.email,
    journalEntryId: w.journalEntryId,
  }));
}

async function demandLetterRows(app: FastifyInstance, from: Date, to: Date) {
  const rows = await app.prisma.demandLetter.findMany({
    where: { draftedAt: { gte: from, lte: to } },
    include: {
      loan: { select: { number: true, customerId: true } },
      draftedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
    },
    orderBy: { draftedAt: "desc" },
  });
  return rows.map((l) => ({
    letterId: l.id,
    loanNumber: l.loan.number,
    customerId: l.loan.customerId,
    stage: l.stage,
    status: l.status,
    daysOverdue: l.daysOverdue,
    totalOwed: Number(l.totalOwed),
    paymentDeadline: l.paymentDeadline.toISOString().slice(0, 10),
    draftedAt: l.draftedAt.toISOString(),
    draftedBy: l.draftedBy.name,
    approvedAt: l.approvedAt?.toISOString() ?? null,
    approvedBy: l.approvedBy?.name ?? null,
    dispatchedAt: l.dispatchedAt?.toISOString() ?? null,
    dispatchedBy: l.dispatchedBy?.name ?? null,
    dispatchChannel: l.dispatchChannel ?? null,
    closedReason: l.closedReason ?? null,
  }));
}

async function repossessionRows(app: FastifyInstance, from: Date, to: Date) {
  const rows = await app.prisma.repossessionCase.findMany({
    where: { identifiedAt: { gte: from, lte: to } },
    include: { loan: { select: { number: true, customerId: true } } },
    orderBy: { identifiedAt: "desc" },
  });
  return rows.map((c) => ({
    caseId: c.id,
    loanNumber: c.loan.number,
    customerId: c.loan.customerId,
    status: c.status,
    identifiedAt: c.identifiedAt.toISOString(),
    reason: c.reason,
    bmApprovedAt: c.bmApprovedAt?.toISOString() ?? null,
    creditHeadApprovedAt: c.creditHeadApprovedAt?.toISOString() ?? null,
    legalApprovedAt: c.legalApprovedAt?.toISOString() ?? null,
    recoveredAt: c.recoveredAt?.toISOString() ?? null,
    auctionedAt: c.auctionedAt?.toISOString() ?? null,
    outstandingAtRecovery: c.outstandingAtRecovery
      ? Number(c.outstandingAtRecovery)
      : null,
    auctionProceeds: c.auctionProceeds ? Number(c.auctionProceeds) : null,
    deficiency: c.deficiency ? Number(c.deficiency) : null,
  }));
}

async function annualDocRows(app: FastifyInstance) {
  const docs = await app.prisma.annualDocument.findMany({
    include: { loan: { select: { number: true, customerId: true } } },
  });
  const byStatus = { VALID: 0, EXPIRING_SOON: 0, EXPIRED: 0 };
  for (const d of docs) byStatus[d.status] += 1;
  return [
    {
      asOf: new Date().toISOString(),
      totalDocs: docs.length,
      valid: byStatus.VALID,
      expiringSoon: byStatus.EXPIRING_SOON,
      expired: byStatus.EXPIRED,
      compliancePct: docs.length ? round4(byStatus.VALID / docs.length) : 0,
    },
    ...docs.map((d) => ({
      docId: d.id,
      loanNumber: d.loan.number,
      customerId: d.loan.customerId,
      type: d.type,
      name: d.name,
      status: d.status,
      effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10),
      expiresAt: d.expiresAt.toISOString().slice(0, 10),
      reminderCount: d.reminderCount,
    })),
  ];
}

async function eclMovementRows(app: FastifyInstance, from: Date, to: Date) {
  const runs = await app.prisma.eclRun.findMany({
    where: { asOf: { gte: from, lte: to } },
    orderBy: { asOf: "asc" },
  });
  return runs.map((r) => ({
    runId: r.id,
    asOf: r.asOf.toISOString().slice(0, 10),
    periodStart: r.periodStart.toISOString().slice(0, 10),
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    totalEad: Number(r.totalEad),
    stage1Ecl: Number(r.stage1Ecl),
    stage1Count: r.stage1Count,
    stage2Ecl: Number(r.stage2Ecl),
    stage2Count: r.stage2Count,
    stage3Ecl: Number(r.stage3Ecl),
    stage3Count: r.stage3Count,
    totalEcl: Number(r.totalEcl),
    delta: Number(r.delta),
    journalEntryId: r.journalEntryId,
  }));
}

// ── Formatters ───────────────────────────────────────────────────────────

function send(
  reply: FastifyReply,
  format: "json" | "csv",
  filename: string,
  rows: Array<Record<string, unknown>>,
) {
  if (format === "csv") {
    const csv = toCsv(rows);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${filename}.csv"`,
    );
    return reply.send(csv);
  }
  return rows;
}

/**
 * Minimal RFC-4180-ish CSV serializer. Quotes fields containing comma,
 * quote, or newline; doubles embedded quotes.
 */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  // Union of all keys (rows may have different shape — e.g. the
  // annual-docs report's summary row vs detail rows).
  const keys = Array.from(
    rows.reduce<Set<string>>((s, r) => {
      Object.keys(r).forEach((k) => s.add(k));
      return s;
    }, new Set()),
  );
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(",")];
  for (const r of rows) {
    lines.push(keys.map((k) => escape(r[k])).join(","));
  }
  return lines.join("\n");
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function oneMonthAgo(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d;
}

function stamp(from?: Date, to?: Date): string {
  const today = new Date().toISOString().slice(0, 10);
  if (!from || !to) return today;
  return `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`;
}
