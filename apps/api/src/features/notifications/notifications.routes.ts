/**
 * Notifications admin routes. Phase 2: tenant-scoped — `app.notifications`
 * is a factory that builds a NotificationRepository on top of the calling
 * tenant's Prisma client.
 */
import type { NotificationRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";

const TAGS = ["notifications"];

const testSchema = z.object({
  channel: z.enum(["EMAIL", "SMS", "IN_APP"]),
  recipient: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

/**
 * `?customerId=&status=&event=` on the dispatch log.
 *
 * All three are plain optional strings, NOT enums, and that is a
 * deliberate under-narrowing. The handler passes them to Prisma with an
 * `as never` cast and no validation, so an unrecognised `status` today
 * reaches the database and fails there. Declaring the enums would move
 * that rejection into Fastify and turn it into a 400 — a better answer,
 * but a different one, and changing behaviour is not this change's job.
 * Written to accept exactly what the handler accepts today.
 */
const listQuerySchema = z.object({
  customerId: z.string().optional(),
  /** QUEUED / SENT / FAILED. Unvalidated — see the note above. */
  status: z.string().optional(),
  /** A NotificationEvent name, e.g. "LOAN_APPROVED". Unvalidated. */
  event: z.string().optional(),
});

/**
 * One dispatch record, as stored.
 *
 * Returned unprojected from `findMany`, so this is the model's scalar
 * list. There are no Decimal columns here. A row reaches the caller
 * whether or not the send succeeded — a provider failure is recorded as
 * `status: "FAILED"` with `error` set, and still answers 200.
 */
const notificationResponseSchema = z.object({
  id: z.string().uuid(),
  /** e.g. "LOAN_APPROVED", "PAYMENT_DUE_SOON", "TEST". */
  event: z.string(),
  channel: z.enum(["EMAIL", "SMS", "IN_APP"]),
  recipient: z.string(),
  /** Null for channels that have no subject line. */
  subject: z.string().nullable(),
  body: z.string(),
  status: z.enum(["QUEUED", "SENT", "FAILED"]),
  /** The provider's own id for the message, when it gave one. */
  providerRef: z.string().nullable(),
  /** The failure, when `status` is FAILED. */
  error: z.string().nullable(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  refNumber: z.string().nullable(),
  customerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
});

/** The dispatch log — a bare array, newest first, capped at 100. */
const notificationListResponseSchema = z.array(notificationResponseSchema);

declare module "fastify" {
  interface FastifyRequest {
    notificationsCtx?: { repo: NotificationRepository };
  }
}

export async function notificationRoutes(app: FastifyInstance) {
  /*
   * `onRequest`, because both routes below now carry request schemas
   * and Fastify validates between `onRequest` and `preHandler`. At
   * `preHandler` an anonymous POST with a malformed body would answer
   * 400 describing the body rather than the 401 it earned.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.notificationsCtx = {
      repo: app.notifications(req.tenantCtx.prisma),
    };
  });

  /**
   * Dispatch log across the whole tenant — recipients, message bodies,
   * delivery status. `?customerId=` filters but does not scope, so this
   * needs `notifications.read` (LOAN_OFFICER, ACCOUNTANT, ADMIN). The
   * borrower's own bell state lives on /auth/me/notifications/state.
   */
  app.get<{
    Querystring: { customerId?: string; status?: string; event?: string };
  }>(
    "/",
    {
      preHandler: app.requirePermission("notifications.read"),
      schema: routeSchema({
        summary:
          "Tenant-wide dispatch log, newest first, capped at 100. " +
          "`?customerId=` filters but does not scope — this is every " +
          "borrower's mail, hence `notifications.read`.",
        tags: TAGS,
        permission: "notifications.read",
        querystring: listQuerySchema,
        response: notificationListResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) =>
      req.notificationsCtx!.repo.list({
        customerId: req.query.customerId,
        status: req.query.status as never,
        event: req.query.event as never,
      }),
  );

  /** Admin-only: fire a TEST notification through the active provider. */
  app.post(
    "/test",
    {
      preHandler: app.requirePermission("notifications.test"),
      schema: routeSchema({
        summary:
          "Fire a TEST notification through the active provider and " +
          "answer the record it wrote. A provider failure is still a " +
          "200 — the row comes back with status FAILED and `error` set.",
        tags: TAGS,
        permission: "notifications.test",
        body: testSchema,
        response: notificationResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = testSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return req.notificationsCtx!.repo.dispatch({
        event: "TEST",
        channel: parsed.data.channel,
        recipient: parsed.data.recipient,
        data: { note: parsed.data.note ?? "sent from /notifications/test" },
      });
    },
  );
}
