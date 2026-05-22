import { type PrismaClient } from "@loan/db";

import type { AuditListQuery } from "./schemas.js";

/**
 * Audit-log reads. Append-only writes happen inline from feature
 * services (via `AuditLogRepository.record()`); this service only
 * exposes the read side.
 *
 * Why this earns a layer at all: the list endpoint joins the actor
 * User for display, then re-shapes the row to flatten the actor join.
 * That mapping doesn't belong in the route handler.
 */
export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: AuditListQuery) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        actorId: query.actorId,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
        createdAt: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      orderBy: { createdAt: "desc" },
      take: query.take ?? 100,
      include: { actor: { select: { id: true, name: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      actorName: r.actor?.name ?? null,
      actorEmail: r.actor?.email ?? null,
      targetType: r.targetType,
      targetId: r.targetId,
      payload: r.payload,
      createdAt: r.createdAt,
    }));
  }

  /** Distinct action labels — powers the UI's filter dropdown. */
  async listDistinctActions(): Promise<string[]> {
    const rows = await this.prisma.auditEvent.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    });
    return rows.map((r) => r.action);
  }
}
