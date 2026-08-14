/**
 * Co-maker consent — `/public/co-maker/*`. Anonymous; the invite token
 * is the authorization.
 *
 *   GET  /public/co-maker/:token            what am I being asked
 *   POST /public/co-maker/:token/respond    approve or decline
 *   POST /public/co-maker/:token/documents  attach a requirement
 *
 * Mounted outside `/api/v1` alongside the other anonymous routes, and
 * deliberately NOT inside `publicRoutes` — that file's contract is
 * "nothing here touches user data", which this does. Keeping it
 * separate keeps that rule honest.
 *
 * ## Tenant
 *
 * Resolution normally reads the JWT's `tenant` claim, and there is no
 * JWT here. The slug travels in the token instead and picks the
 * client directly. In single-tenant mode the shared client is used
 * and the slug is ignored.
 *
 * ## Rate limit
 *
 * Tight, like the other anonymous routes. The token is 32 random
 * bytes so guessing is not a real threat, but an open endpoint that
 * reads loan details deserves a ceiling regardless.
 */

import { CoMakerRepository, type PrismaClient } from "@loan/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { join } from "node:path";

import { config } from "../../config";
import { storeUpload } from "../uploads/store";
import { routeSchema } from "../../lib/openapi";
import { CoMakerConsentService, parseInviteToken } from "./consent.service";
import {
  consentViewResponseSchema,
  documentResponseSchema,
  documentSchema,
  respondResponseSchema,
  respondSchema,
  tokenParamSchema,
  uploadResponseSchema,
} from "./consent.schemas";

const TAGS = ["co-maker"];

const rateLimit = {
  config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
};

/*
 * ─── Auth posture: NONE, and that is correct ──────────────────────────
 *
 * No `app.authenticate` hook anywhere in this file, unlike every other
 * group documented in this batch. A borrower's co-maker is not a user
 * of this system — they have no account, no session and no password —
 * and the invite token IS the authorization. Adding authentication here
 * would not harden the endpoint, it would break the only way a co-maker
 * can ever answer.
 *
 * So the usual 401→400 trap does not apply and **401 is not declared on
 * any operation below**. Declaring it would be a lie in the direction
 * that matters most: an integrator reading 401 would go looking for
 * credentials that do not exist.
 *
 * Attaching request schemas does still move validation ahead of the
 * handler's token lookup, so a malformed body against an unknown token
 * now answers 400 rather than 404. That is harmless here — the shapes
 * are already public API for an anonymous form, and the change reveals
 * nothing about whether the token was real.
 *
 * ─── Two statuses these operations send that the spec cannot say ─────
 *
 * `ERRORS` in lib/openapi.ts has no 410 and no 413, and both are
 * genuinely reachable:
 *
 *   • 410 Gone — every route here answers it for an EXPIRED invite, and
 *     it is a meaningful distinction from 404 (the link was real; it
 *     lapsed). An integrator wants to tell "resend the invite" from
 *     "this link never existed".
 *   • 413 — /upload returns it when `storeUpload` rejects an oversized
 *     file.
 *
 * Left undeclared rather than hand-rolled: a second error envelope
 * defined locally would be exactly the divergence the shared components
 * exist to prevent. Both are reported for a follow-up that adds them to
 * `ERRORS` centrally.
 */

export async function coMakerConsentRoutes(app: FastifyInstance) {
  const uploadsDir = config.uploadsDir || join(process.cwd(), "uploads");

  /**
   * Bind the tenant named by the token. Returns null (having replied)
   * when the token is malformed or names a tenant that isn't serving.
   */
  const clientFor = async (
    raw: string,
    reply: FastifyReply,
  ): Promise<PrismaClient | null> => {
    const parsed = parseInviteToken(raw);
    if (!parsed) {
      await reply.code(404).send({ error: "NotFound" });
      return null;
    }
    if (!config.multiTenant) return app.prisma;
    const tenant = await app.prisma.tenant.findUnique({
      where: { slug: parsed.tenantSlug },
      select: { status: true },
    });
    if (!tenant || tenant.status === "ARCHIVED") {
      await reply.code(404).send({ error: "NotFound" });
      return null;
    }
    if (tenant.status !== "ACTIVE") {
      await reply.code(503).send({ error: "TenantUnavailable" });
      return null;
    }
    return app.tenantPrisma.get(parsed.tenantSlug);
  };

  const serviceFor = (prisma: PrismaClient) => ({
    repo: new CoMakerRepository(prisma),
    get consent() {
      return new CoMakerConsentService(this.repo);
    },
  });

  app.get<{ Params: { token: string } }>(
    "/:token",
    {
      ...rateLimit,
      schema: routeSchema({
        summary:
          "What this co-maker is being asked to agree to. Anonymous — " +
          "the invite token is the authorization. 410 once it expires.",
        tags: TAGS,
        params: tokenParamSchema,
        response: consentViewResponseSchema,
        errors: [404, 429],
      }),
    },
    async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
      const prisma = await clientFor(req.params.token, reply);
      if (!prisma) return;
      const svc = serviceFor(prisma);
      const found = await svc.consent.lookup(req.params.token);

      /*
       * Record the open BEFORE deciding what to answer.
       *
       * This GET is the only moment the system ever hears from a
       * co-maker who hasn't replied — they have no account and no
       * session, so the request itself is the entire signal that the
       * link reached a human. That is just as true when they click a
       * day late: an expired open still tells the officer the link was
       * delivered, which is precisely what separates "they've seen it"
       * from "it never arrived". Only a token matching no row at all
       * leaves nothing to record.
       *
       * Not awaited, and caught. A co-maker in front of a consent form
       * must never be shown an error because a bookkeeping write
       * failed; the page is the point and the timestamp is a nicety.
       * Same reasoning as the user heartbeat in app.ts.
       */
      const opened =
        found.ok || found.reason === "Expired" ? found.invite : null;
      if (opened) {
        void svc.repo.markLinkOpened(opened.id).catch((err: unknown) => {
          app.log.debug(
            { err, coMakerId: opened.id },
            "link-open stamp failed",
          );
        });
      }

      if (!found.ok) {
        return reply
          .code(found.reason === "Expired" ? 410 : 404)
          .send({ error: found.reason });
      }
      const i = found.invite;
      const loan = i.loan;

      const config_ = await prisma.systemConfig.findFirst({
        select: { companyName: true },
      });
      return {
        coMakerId: i.id,
        fullName: i.fullName,
        role: i.role,
        status: i.status,
        respondedAt: i.respondedAt,
        // What the product asks of a borrower is what we ask of a
        // co-maker: they're taking on the same liability.
        requiredDocuments: loan.product?.requiredKycDocs ?? [],
        documents: i.documents,
        loan: {
          number: loan.number,
          principal: Number(loan.principal),
          termMonths: loan.termMonths,
          productName: loan.product?.name ?? "",
          borrowerName:
            `${loan.customer.firstName} ${loan.customer.lastName}`.trim(),
        },
        lender: { companyName: config_?.companyName ?? config.companyName },
      };
    },
  );

  app.post<{ Params: { token: string } }>(
    "/:token/respond",
    {
      ...rateLimit,
      schema: routeSchema({
        summary:
          "Approve or decline. A decline needs a reason. 409 once " +
          "answered — the decision is not revisable; 410 if expired.",
        tags: TAGS,
        params: tokenParamSchema,
        body: respondSchema,
        response: respondResponseSchema,
        errors: [400, 404, 409, 429],
      }),
    },
    async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
      const prisma = await clientFor(req.params.token, reply);
      if (!prisma) return;
      const parsed = respondSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const svc = serviceFor(prisma);
      const result = await svc.consent.respond(
        req.params.token,
        parsed.data.decision,
        parsed.data.declineReason,
      );
      if (!result.ok) {
        const code =
          result.reason === "Expired"
            ? 410
            : result.reason === "AlreadyAnswered"
              ? 409
              : 404;
        return reply.code(code).send({ error: result.reason });
      }
      return { ok: true };
    },
  );

  /**
   * Upload a file. Token-scoped because a co-maker has no account and
   * so can't call the authenticated `/uploads-api` route — but it goes
   * through the same `storeUpload`, so the extension allowlist and the
   * size cap are one implementation rather than two.
   */
  app.post<{ Params: { token: string } }>(
    "/:token/upload",
    {
      ...rateLimit,
      /*
       * No `body` here, deliberately. This is a multipart upload read
       * via `req.file()` — attaching a JSON body schema would make
       * Fastify validate the multipart stream as an object and reject
       * every real request. The response is documented; the request is
       * a file, which routeSchema has no way to describe.
       *
       * The 413 this can answer is not in ERRORS — see the note at the
       * top of this file.
       */
      schema: routeSchema({
        summary:
          "Upload a supporting file (multipart). Answers the stored URL, " +
          "which /documents then records. 413 if it exceeds the cap.",
        tags: TAGS,
        params: tokenParamSchema,
        response: uploadResponseSchema,
        status: 201,
        errors: [400, 404, 429],
      }),
    },
    async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
      const prisma = await clientFor(req.params.token, reply);
      if (!prisma) return;
      const found = await serviceFor(prisma).consent.lookup(req.params.token);
      if (!found.ok) {
        return reply
          .code(found.reason === "Expired" ? 410 : 404)
          .send({ error: found.reason });
      }
      const file = await req.file();
      if (!file) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "No file" });
      }
      const stored = await storeUpload(file, "kyc", uploadsDir);
      if (!stored.ok) {
        return reply.code(stored.code).send({
          error: stored.code === 413 ? "TooLarge" : "BadRequest",
          message: stored.message,
        });
      }
      return reply.code(201).send({ url: stored.url });
    },
  );

  /**
   * Record an attached requirement, by URL from the upload above.
   */
  app.post<{ Params: { token: string } }>(
    "/:token/documents",
    {
      ...rateLimit,
      schema: routeSchema({
        summary:
          "Record an uploaded file against this co-maker. 409 if they " +
          "already declined — a declined co-maker has nothing to file.",
        tags: TAGS,
        params: tokenParamSchema,
        body: documentSchema,
        response: documentResponseSchema,
        status: 201,
        errors: [400, 404, 409, 429],
      }),
    },
    async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
      const prisma = await clientFor(req.params.token, reply);
      if (!prisma) return;
      const parsed = documentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const svc = serviceFor(prisma);
      const found = await svc.consent.lookup(req.params.token);
      if (!found.ok) {
        return reply
          .code(found.reason === "Expired" ? 410 : 404)
          .send({ error: found.reason });
      }
      // A declined co-maker has nothing to upload; an approved one may
      // still be completing their file.
      if (found.invite.status === "DECLINED") {
        return reply.code(409).send({ error: "Declined" });
      }
      return reply.code(201).send(
        await svc.repo.addDocument({
          coMakerId: found.invite.id,
          documentType: parsed.data.documentType,
          documentUrl: parsed.data.documentUrl,
        }),
      );
    },
  );
}
