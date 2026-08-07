import {
  resolvePaging,
  toPage,
  tokenizedWhere,
  contains,
  type PrismaClient,
} from "@loan/db";

import type { AuditListQuery } from "./schemas";

/**
 * Audit-log reads. Append-only writes happen inline from feature
 * services (via `AuditLogRepository.record()`); this service only
 * exposes the read side.
 *
 * Why this earns a layer at all: the list endpoint joins the actor
 * User for display, then re-shapes the row to flatten the actor join.
 * That mapping doesn't belong in the route handler.
 */
/**
 * 25 fits the drawer without scrolling past the filters; 200 is the
 * ceiling for a script pulling a period in bulk.
 */
const AUDIT_PAGING = { defaultPageSize: 25, maxPageSize: 200 };

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: AuditListQuery) {
    /*
     * The actor search runs HERE, not in the browser.
     *
     * It used to filter the loaded page client-side, which meant a name
     * only turned up if it happened to appear in the 25 rows already on
     * screen — so "what did Maria do last quarter" answered "nothing"
     * whenever Maria was on page 9. On an audit log that is not a
     * cosmetic limitation; it is a wrong answer to the question the
     * screen exists to ask.
     *
     * Tokenized for the same reason the customer and loan lists are:
     * people type "maria cruz" and "cruz maria", and neither is a
     * substring of `name` or of `email`. Every token has to match
     * somewhere on the actor, so both orders find her and neither
     * returns every other Maria.
     */
    const actorMatch = tokenizedWhere(query.actor, (token) => [
      { name: contains(token) },
      { email: contains(token) },
    ]);

    const where = {
      actorId: query.actorId,
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
      // Undefined when no search was typed, which Prisma drops.
      actor: actorMatch,
      createdAt: {
        gte: query.from ? new Date(query.from) : undefined,
        lte: query.to ? new Date(query.to) : undefined,
      },
    };
    /*
     * `take` still wins when no page is asked for, so existing callers
     * keep working. A paged caller has already stated its size.
     */
    const paging = resolvePaging(
      { page: query.page, pageSize: query.pageSize ?? query.take },
      AUDIT_PAGING,
    );
    const [rows, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: paging.skip,
        take: paging.take,
        include: { actor: { select: { id: true, name: true, email: true } } },
      }),
      /*
       * Counted, not inferred from the page. An audit log is the one
       * table where "how many are there" is itself the answer to a
       * question — "how many times was this done, and by whom" — and a
       * page length cannot say.
       */
      this.prisma.auditEvent.count({ where }),
    ]);
    const mapped = rows.map((r) => ({
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
    return toPage(mapped, total, paging);
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
