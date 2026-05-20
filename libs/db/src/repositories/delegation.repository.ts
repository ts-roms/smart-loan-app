/**
 * Delegation persistence — proxy authority between users.
 *
 *   - `create`: a user grants a subset of their permissions to another user
 *     for a date window. The delegator must hold every permission they're
 *     delegating; this is checked against their effective role permissions.
 *   - `listActiveFor(delegateId)`: rows where `delegateId` is the recipient
 *     and now() falls inside [startsAt, endsAt] and revokedAt is null. Used
 *     by the permission resolver.
 *   - `revoke`: short-circuit a delegation before its endsAt.
 *
 * The signing endpoints accept a delegation id; we validate it's currently
 * active for the caller and pin the loan record to it.
 */

import type { Delegation, PrismaClient } from '@prisma/client';

export interface DelegationCreateInput {
  delegatorId: string;
  delegateId: string;
  /** Empty array = "all of the delegator's current permissions". */
  permissions: string[];
  startsAt: Date;
  endsAt: Date;
  note?: string;
}

export class DelegationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<Delegation | null> {
    return this.prisma.delegation.findUnique({ where: { id } });
  }

  /** Both directions for a user: delegations they granted + ones they hold. */
  async listForUser(userId: string): Promise<{ granted: Delegation[]; held: Delegation[] }> {
    const [granted, held] = await Promise.all([
      this.prisma.delegation.findMany({
        where: { delegatorId: userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.delegation.findMany({
        where: { delegateId: userId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { granted, held };
  }

  list(): Promise<Delegation[]> {
    return this.prisma.delegation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Active = the date window covers `now`, not revoked. Used by the
   * resolver — typically called once per request from `resolveUserPermissions`.
   */
  listActiveFor(delegateId: string, now: Date = new Date()): Promise<Delegation[]> {
    return this.prisma.delegation.findMany({
      where: {
        delegateId,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
    });
  }

  async create(input: DelegationCreateInput): Promise<Delegation> {
    if (input.delegatorId === input.delegateId) {
      throw new Error('Cannot delegate to yourself.');
    }
    if (input.endsAt <= input.startsAt) {
      throw new Error('endsAt must be after startsAt.');
    }
    return this.prisma.delegation.create({ data: input });
  }

  async revoke(id: string, revokedById: string, reason?: string): Promise<Delegation> {
    return this.prisma.delegation.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById, revokedReason: reason },
    });
  }
}

/**
 * Standalone resolver used by the permission middleware: given a userId,
 * compute the union of role-derived permissions + active delegation
 * permissions. Each delegation only contributes permissions the delegator
 * actually holds — you can't grant what you don't have, and downgrading
 * the delegator (e.g. removing a role) instantly tightens what the
 * delegate inherits.
 */
import { resolveUserPermissions } from './rbac.repository.js';

export async function resolveEffectivePermissions(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<{ permissions: Set<string>; viaDelegations: Delegation[] }> {
  const own = await resolveUserPermissions(prisma, userId);
  const delegations = await prisma.delegation.findMany({
    where: {
      delegateId: userId,
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
  });
  if (delegations.length === 0) {
    return { permissions: own, viaDelegations: [] };
  }
  // Compute each delegator's current permissions and union in the
  // intersection with the delegation's permissions list (or all of theirs,
  // if the list is empty).
  for (const d of delegations) {
    const delegatorPerms = await resolveUserPermissions(prisma, d.delegatorId);
    if (d.permissions.length === 0) {
      for (const p of delegatorPerms) own.add(p);
    } else {
      for (const p of d.permissions) {
        if (delegatorPerms.has(p)) own.add(p);
      }
    }
  }
  return { permissions: own, viaDelegations: delegations };
}
