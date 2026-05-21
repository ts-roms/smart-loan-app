/**
 * Delegation routes. Three views:
 *   - GET  /delegations            — caller's own delegations (granted + held)
 *   - GET  /delegations/all        — system-wide list (admin.users)
 *   - POST /delegations            — create one (delegator is the caller by default)
 *   - POST /delegations/:id/revoke — revoke early (caller must be delegator or ADMIN)
 *
 * Validation we enforce at create time:
 *   - cannot delegate to yourself
 *   - endsAt > startsAt
 *   - every permission you're granting must be one you currently hold
 *     (resolver-side; not just role membership)
 *
 * If permissions[] is empty, the delegation copies the delegator's *current*
 * permission set at evaluation time — meaning permission changes propagate
 * automatically.
 */

import {
  AuditLogRepository,
  DelegationRepository,
  resolveUserPermissions,
} from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const createSchema = z.object({
  delegateId: z.string().uuid(),
  /** Optional — if you have admin.users you can delegate on behalf of someone else. */
  delegatorId: z.string().uuid().optional(),
  permissions: z.array(z.string()).max(200).default([]),
  startsAt: z.string(),
  endsAt: z.string(),
  note: z.string().max(500).optional(),
});

const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function delegationRoutes(app: FastifyInstance) {
  const repo = new DelegationRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  /**
   * Lightweight user directory — id, name, email, primaryRole — for
   * delegation pickers. Any authenticated user can read this; it's the
   * minimum needed to pick a delegate without giving away the full
   * admin user list (which requires admin.users).
   */
  app.get("/users/directory", async () => {
    const users = await app.prisma.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });
    return users;
  });

  /** Caller's own delegations (both directions). */
  app.get("/", async (req) => repo.listForUser(req.user.sub));

  /** Full system view — for the admin Delegations page. */
  app.get(
    "/all",
    { preHandler: app.requirePermission("admin.users") },
    async () => repo.list(),
  );

  /** Active delegations the caller currently holds. UI uses this for the banner. */
  app.get("/active", async (req) => repo.listActiveFor(req.user.sub));

  app.post("/", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const callerPerms =
      req.permissions ?? (await app.resolvePermissions(req.user.sub));
    // If a delegatorId was provided and it's not the caller, the caller
    // must be an admin (admin.users implies "can act on user records").
    const delegatorId = parsed.data.delegatorId ?? req.user.sub;
    if (delegatorId !== req.user.sub && !callerPerms.has("admin.users")) {
      return reply.code(403).send({
        error: "Forbidden",
        message: "You can only delegate from your own account.",
      });
    }

    // Permission gate on the delegation contents — every key listed must be
    // one the *delegator* currently holds. Empty list = "all my permissions"
    // and is always allowed (filtered at evaluation time anyway).
    if (parsed.data.permissions.length > 0) {
      const delegatorPerms = await resolveUserPermissions(
        app.prisma,
        delegatorId,
      );
      const missing = parsed.data.permissions.filter(
        (p) => !delegatorPerms.has(p),
      );
      if (missing.length > 0) {
        return reply.code(403).send({
          error: "Forbidden",
          message: `Cannot delegate permissions the delegator does not hold: ${missing.join(", ")}`,
        });
      }
    }

    try {
      const d = await repo.create({
        delegatorId,
        delegateId: parsed.data.delegateId,
        permissions: parsed.data.permissions,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: new Date(parsed.data.endsAt),
        note: parsed.data.note,
      });
      await audit.record({
        action: "DELEGATION_CREATE",
        actorId: req.user.sub,
        targetType: "Delegation",
        targetId: d.id,
        payload: {
          delegatorId,
          delegateId: parsed.data.delegateId,
          permissions: parsed.data.permissions,
          startsAt: parsed.data.startsAt,
          endsAt: parsed.data.endsAt,
        },
      });
      return reply.code(201).send(d);
    } catch (err) {
      return reply.code(400).send({
        error: "BadRequest",
        message: (err as Error).message,
      });
    }
  });

  app.post<{ Params: { id: string } }>("/:id/revoke", async (req, reply) => {
    const parsed = revokeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const d = await repo.findById(req.params.id);
    if (!d) return reply.code(404).send({ error: "NotFound" });

    // Delegator can always revoke their own; admin.users can revoke any.
    const callerPerms =
      req.permissions ?? (await app.resolvePermissions(req.user.sub));
    if (d.delegatorId !== req.user.sub && !callerPerms.has("admin.users")) {
      return reply
        .code(403)
        .send({
          error: "Forbidden",
          message: "Cannot revoke this delegation.",
        });
    }

    const updated = await repo.revoke(d.id, req.user.sub, parsed.data.reason);
    await audit.record({
      action: "DELEGATION_REVOKE",
      actorId: req.user.sub,
      targetType: "Delegation",
      targetId: updated.id,
      payload: { reason: parsed.data.reason },
    });
    return updated;
  });

  // Extend an active delegation's end date — saves the revoke+recreate
  // dance when "the manager isn't back yet, push it another week".
  // Refuses to shorten; revoking is a different action with its own
  // audit story.
  const extendSchema = z.object({
    endsAt: z.string().datetime(),
  });
  app.post<{ Params: { id: string } }>("/:id/extend", async (req, reply) => {
    const parsed = extendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const d = await repo.findById(req.params.id);
    if (!d) return reply.code(404).send({ error: "NotFound" });

    const callerPerms =
      req.permissions ?? (await app.resolvePermissions(req.user.sub));
    if (d.delegatorId !== req.user.sub && !callerPerms.has("admin.users")) {
      return reply
        .code(403)
        .send({
          error: "Forbidden",
          message: "Cannot extend this delegation.",
        });
    }
    if (d.revokedAt) {
      return reply
        .code(409)
        .send({
          error: "Conflict",
          message: "Delegation has been revoked; create a new one.",
        });
    }
    const newEnd = new Date(parsed.data.endsAt);
    if (newEnd <= d.endsAt) {
      return reply.code(400).send({
        error: "BadRequest",
        message:
          "New end date must be after the current one. To shorten, revoke and recreate.",
      });
    }

    const updated = await repo.extend(d.id, newEnd);
    await audit.record({
      action: "DELEGATION_EXTEND",
      actorId: req.user.sub,
      targetType: "Delegation",
      targetId: updated.id,
      payload: {
        previousEndsAt: d.endsAt.toISOString(),
        newEndsAt: newEnd.toISOString(),
      },
    });
    return updated;
  });
}
