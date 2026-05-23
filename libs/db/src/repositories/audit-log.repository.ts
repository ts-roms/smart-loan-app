/**
 * Audit log — append-only record of privileged actions.
 *
 * Any route that mutates significant state should call `record()` with the
 * coarse action label, the actor id from the JWT, and an optional payload.
 * Never throws; logging failures are non-fatal.
 *
 * ## Impersonation
 *
 * When the call is coming from a platform-impersonated session (the
 * JWT carries an `impersonatedBy` claim), the repository stamps every
 * row with the impersonator's platform user id + email. Two paths:
 *
 *   1. **Default-via-constructor (recommended).** Per-request
 *      preHandlers build the repo with the caller's `req.user`; every
 *      `record()` automatically picks up the impersonator. Services
 *      themselves don't need to know impersonation exists.
 *
 *   2. **Per-call override.** A `record()` call can pass an explicit
 *      `impersonatedBy` (or `null` to suppress the default). Rare —
 *      useful when one service records on behalf of another actor.
 *
 * Compliance can run "what did vendor support do against tenant X?"
 * by filtering on `impersonatedByEmail` alone.
 */

import type { AuditEvent, Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Shape of the JWT `impersonatedBy` claim. Same as the one defined in
 * `@loan/auth` types; redefined here so libs/db doesn't carry an
 * @loan/auth dependency.
 */
export interface AuditImpersonator {
  platformUserId: string;
  platformUserEmail: string;
  purpose?: string;
}

export interface AuditEventInput {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
  tx?: Tx;
  /**
   * Per-call override. Defaults to the repo's `defaultImpersonator`
   * when omitted. Pass `null` explicitly to suppress the default (one
   * service recording on behalf of someone else — e.g. an automated
   * job).
   */
  impersonatedBy?: AuditImpersonator | null;
}

export class AuditLogRepository {
  /**
   * @param prisma                  Tenant-bound Prisma client.
   * @param defaultImpersonator     Optional. When the per-request factory
   *                                passes the caller's JWT impersonator
   *                                here, every audit row inherits it
   *                                automatically. Null/undefined leaves
   *                                rows unmarked.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultImpersonator?: AuditImpersonator | null,
  ) {}

  async record(input: AuditEventInput): Promise<AuditEvent | null> {
    const client = input.tx ?? this.prisma;
    // `undefined` means "use the default"; explicit `null` means
    // "no impersonator" even if the repo has a default. Important for
    // job-driven writes that shouldn't be tagged with whoever
    // happened to trigger the parent request.
    const imp =
      input.impersonatedBy === undefined
        ? (this.defaultImpersonator ?? null)
        : input.impersonatedBy;
    try {
      return await client.auditEvent.create({
        data: {
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          payload:
            (input.payload as Prisma.InputJsonValue | undefined) ?? undefined,
          impersonatedById: imp?.platformUserId,
          impersonatedByEmail: imp?.platformUserEmail,
        },
      });
    } catch (err) {
      // Don't let audit failures break the underlying business action.
      // Console.error is loud enough for now; wire this to your logger of choice.
      console.error("[audit] failed to record event", input.action, err);
      return null;
    }
  }

  list(filter?: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    impersonatedById?: string;
    impersonatedByEmail?: string;
    from?: Date;
    to?: Date;
    take?: number;
  }): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: {
        actorId: filter?.actorId,
        action: filter?.action,
        targetType: filter?.targetType,
        targetId: filter?.targetId,
        impersonatedById: filter?.impersonatedById,
        impersonatedByEmail: filter?.impersonatedByEmail,
        createdAt: {
          gte: filter?.from,
          lte: filter?.to,
        },
      },
      orderBy: { createdAt: "desc" },
      take: filter?.take ?? 200,
    });
  }
}
