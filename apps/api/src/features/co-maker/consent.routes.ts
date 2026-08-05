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
import { CoMakerConsentService, parseInviteToken } from "./consent.service";
import { respondSchema, documentSchema } from "./consent.schemas";

const rateLimit = {
  config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
};

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
    rateLimit,
    async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
      const prisma = await clientFor(req.params.token, reply);
      if (!prisma) return;
      const svc = serviceFor(prisma);
      const found = await svc.consent.lookup(req.params.token);
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
    rateLimit,
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
    rateLimit,
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
    rateLimit,
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
