/**
 * Audit log — append-only record of privileged actions.
 *
 * Any route that mutates significant state should call `record()` with the
 * coarse action label, the actor id from the JWT, and an optional payload.
 * Never throws; logging failures are non-fatal.
 */

import type { AuditEvent, Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AuditEventInput {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
  tx?: Tx;
}

export class AuditLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditEventInput): Promise<AuditEvent | null> {
    const client = input.tx ?? this.prisma;
    try {
      return await client.auditEvent.create({
        data: {
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          payload: (input.payload as Prisma.InputJsonValue | undefined) ?? undefined,
        },
      });
    } catch (err) {
      // Don't let audit failures break the underlying business action.
      // Console.error is loud enough for now; wire this to your logger of choice.
      console.error('[audit] failed to record event', input.action, err);
      return null;
    }
  }

  list(filter?: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
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
        createdAt: {
          gte: filter?.from,
          lte: filter?.to,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: filter?.take ?? 200,
    });
  }
}
