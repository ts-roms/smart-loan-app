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
  KycRepository,
  LoanRepository,
  PaymentIntentRepository,
} from "@loan/db";
import { MockProvider } from "@loan/payments";
import type { FastifyInstance } from "fastify";

import { PortalController } from "./portal.controller.js";
import { PortalService } from "./portal.service.js";

export async function portalRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });
  const intentWebhookUrl = `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`;

  const service = new PortalService(
    app.prisma,
    new LoanRepository(app.prisma),
    new CreditScoreRepository(app.prisma),
    new KycRepository(app.prisma),
    new CooperativeRepository(app.prisma),
    new CustomerLedgerRepository(app.prisma),
    new PaymentIntentRepository(app.prisma, provider),
    intentWebhookUrl,
  );
  const ctrl = new PortalController(service);

  app.addHook("preHandler", app.authenticate);

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
