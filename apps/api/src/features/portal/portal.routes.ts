/**
 * Self-serve borrower portal routes.
 *
 * Auth: requires a logged-in CUSTOMER. Every action is implicitly
 * scoped to the `Customer` row linked to `User.customerId`. No path
 * accepts a customer identifier — the service resolves it from the
 * JWT subject and refuses to touch any other customer's rows.
 *
 * Layered: routes → controller → service → repos. The service's
 * `resolveCustomerId` is the explicit scoping step (returns
 * `{ ok: false, kind: "NotLinked" }` → 403). Every subsequent service
 * method takes `customerId` as its first arg so ownership scoping is
 * type-checked rather than convention-checked.
 */

import {
  CooperativeRepository,
  CreditScoreRepository,
  CustomerLedgerRepository,
  DecisionRuleRepository,
  KycRepository,
  LoanRepository,
  PaymentIntentRepository,
  PreAssessmentRepository,
} from "@loan/db";
import { MockProvider } from "@loan/payments";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../../config";
import { PreAssessmentService } from "../pre-assessment/index";

import { PortalController } from "./portal.controller";
import { PortalService } from "./portal.service";

declare module "fastify" {
  interface FastifyRequest {
    portalServices?: { portal: PortalService };
  }
}

export async function portalRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });

  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    // Webhook URL embeds the tenant slug in multi-tenant mode (mirrors
    // features/payments) so the provider callback reaches the right schema.
    const intentWebhookUrl = config.multiTenant
      ? `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}/${req.tenantCtx.slug}`
      : `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`;
    req.portalServices = {
      portal: new PortalService(
        prisma,
        new LoanRepository(prisma),
        new CreditScoreRepository(prisma),
        new KycRepository(prisma),
        new CooperativeRepository(prisma),
        new CustomerLedgerRepository(prisma),
        new PaymentIntentRepository(prisma, provider),
        intentWebhookUrl,
        // Same service the staff /pre-assessments routes build. The
        // borrower endpoint differs only in forcing the subject to the
        // caller's own customer row.
        new PreAssessmentService(
          {
            prisma,
            screening: app.screening(prisma),
            scores: new CreditScoreRepository(prisma),
            kyc: new KycRepository(prisma),
            rules: new DecisionRuleRepository(prisma),
          },
          new PreAssessmentRepository(prisma),
        ),
      ),
    };
  });

  const ctrl = new PortalController();

  // ─── /me ──────────────────────────────────────────────────────────
  app.get("/me", ctrl.me);
  app.patch("/me", ctrl.updateProfile);

  // ─── loans ────────────────────────────────────────────────────────
  app.get("/loans", ctrl.listLoans);
  app.get<{ Params: { id: string } }>("/loans/:id", ctrl.getLoan);
  app.post<{ Params: { id: string } }>(
    "/loans/:id/sign-borrower",
    ctrl.signBorrower,
  );
  app.post("/loans/apply", ctrl.applyLoan);

  // ─── pre-assessment ───────────────────────────────────────────────
  // "Would I be approved?" before committing to an application. Saved,
  // so the borrower can come back to what they were told.
  app.get("/pre-assessments", ctrl.listPreAssessments);
  app.post("/pre-assessments", ctrl.preAssess);

  // ─── KYC ─────────────────────────────────────────────────────────
  app.get("/kyc", ctrl.listKyc);
  app.post("/kyc", ctrl.submitKyc);

  // ─── payments ─────────────────────────────────────────────────────
  app.post("/payments/intents", ctrl.createIntent);
  app.get<{ Params: { id: string } }>("/payments/intents/:id", ctrl.getIntent);

  // ─── ledgers ──────────────────────────────────────────────────────
  app.get("/member-ledger", ctrl.memberLedger);
  app.get("/me/ledger", ctrl.customerLedger);
  app.get("/me/ledger.pdf", ctrl.customerLedgerPdf);

  // ─── cooperative history ──────────────────────────────────────────
  app.get("/contributions", ctrl.contributions);
  app.get("/savings", ctrl.savings);
}
