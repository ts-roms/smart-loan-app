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
import { z } from "zod";

import { config } from "../../config";
import { routeSchema } from "../../lib/openapi";
import { customerLedgerResponseSchema } from "../customers/schemas";
import {
  contributionResponseSchema,
  memberLedgerResponseSchema,
  savingsTransactionResponseSchema,
} from "../cooperative/schemas";
import {
  declarationsResponseSchema,
  loanDetailResponseSchema,
  loanResponseSchema,
} from "../loans/schemas";
import { paymentIntentResponseSchema } from "../payments/schemas";
import {
  portalPreAssessmentSchema,
  PreAssessmentService,
} from "../pre-assessment/index";

import { PortalController } from "./portal.controller";
import { PortalService } from "./portal.service";
import {
  applyRequestSchema,
  formatQuerySchema,
  intentSchema,
  kycListResponseSchema,
  kycSubmissionResponseSchema,
  kycSubmitSchema,
  ledgerQuerySchema,
  meResponseSchema,
  portalDeclarationAnswersRequestSchema,
  portalIdParamSchema,
  portalLoanListResponseSchema,
  portalPreAssessmentResponseSchema,
  profileResponseSchema,
  profileUpdateSchema,
  signSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    portalServices?: { portal: PortalService };
  }
}

const TAGS = ["portal"];

export async function portalRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });

  // onRequest, not preHandler — routes in this group carry request
  // schemas, and Fastify validates at preValidation, BEFORE preHandler.
  // With authenticate at preHandler an unauthenticated caller with a
  // malformed body got a 400 describing the schema instead of a 401.
  // See decision-rules.routes.ts for the full account. The CUSTOMER
  // scoping itself is unchanged: it lives in the controller's guard
  // (resolveCustomerId → 403), which still runs after validation.
  app.addHook("onRequest", app.authenticate);
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
  app.get(
    "/me",
    {
      schema: routeSchema({
        summary:
          "The borrower's own record plus their latest credit score. " +
          "403 = the login is not a CUSTOMER account linked to a customer row.",
        tags: TAGS,
        response: meResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.me,
  );
  app.patch(
    "/me",
    {
      schema: routeSchema({
        summary:
          "Self-service profile edit — contact and address only. Names, " +
          "DOB, government ID, income and KYC status are refused: those " +
          "need officer re-verification.",
        tags: TAGS,
        body: profileUpdateSchema,
        response: profileResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.updateProfile,
  );

  // ─── loans ────────────────────────────────────────────────────────
  app.get(
    "/loans",
    {
      schema: routeSchema({
        summary:
          "The borrower's applications, newest first, each carrying its " +
          "current balance (null before disbursement).",
        tags: TAGS,
        response: portalLoanListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listLoans,
  );
  app.get<{ Params: { id: string } }>(
    "/loans/:id",
    {
      schema: routeSchema({
        summary:
          "One of the borrower's own loans — row plus schedule, payments " +
          "and joins. 404 covers 'not yours' too.",
        tags: TAGS,
        params: portalIdParamSchema,
        response: loanDetailResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.getLoan,
  );
  app.post<{ Params: { id: string } }>(
    "/loans/:id/sign-borrower",
    {
      schema: routeSchema({
        summary:
          "Borrower signs their own loan from the portal. Records the " +
          "signature blob, the moment, and the caller's IP.",
        tags: TAGS,
        params: portalIdParamSchema,
        body: signSchema,
        response: loanResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.signBorrower,
  );
  app.post(
    "/loans/apply",
    {
      schema: routeSchema({
        summary:
          "Borrower self-apply. The customer is always the caller — no " +
          "customerId is accepted. 409 = they already have a live loan.",
        tags: TAGS,
        body: applyRequestSchema,
        response: loanResponseSchema,
        status: 201,
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.applyLoan,
  );
  // Borrower answers their product's KYC declarations — allowed until
  // the application is decided, then frozen (the answers are part of
  // what approval judged).
  app.put<{ Params: { id: string } }>(
    "/loans/:id/declarations",
    {
      schema: routeSchema({
        summary:
          "Answer or amend the application's KYC declarations. Frozen " +
          "once the loan is decided — 409 after that.",
        tags: TAGS,
        params: portalIdParamSchema,
        body: portalDeclarationAnswersRequestSchema,
        response: declarationsResponseSchema,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.answerDeclarations,
  );

  // ─── pre-assessment ───────────────────────────────────────────────
  // "Would I be approved?" before committing to an application. Saved,
  // so the borrower can come back to what they were told.
  app.get(
    "/pre-assessments",
    {
      schema: routeSchema({
        summary: "The borrower's own saved pre-assessments, newest first.",
        tags: TAGS,
        response: z.array(portalPreAssessmentResponseSchema),
        errors: [401, 403],
      }),
    },
    ctrl.listPreAssessments,
  );
  app.post(
    "/pre-assessments",
    {
      schema: routeSchema({
        summary:
          "'Would I be approved for this?' — run and save a pre-assessment " +
          "against the caller's own record. The subject is forced from the " +
          "JWT, so a borrower can only assess themselves.",
        tags: TAGS,
        body: portalPreAssessmentSchema,
        response: portalPreAssessmentResponseSchema,
        status: 201,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.preAssess,
  );

  // ─── KYC ─────────────────────────────────────────────────────────
  app.get(
    "/kyc",
    {
      schema: routeSchema({
        summary:
          "The borrower's KYC documents plus the completeness rollup " +
          "(what is missing, what was rejected).",
        tags: TAGS,
        response: kycListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listKyc,
  );
  app.post(
    "/kyc",
    {
      schema: routeSchema({
        summary:
          "Submit a KYC document for review. 409 when a submission of " +
          "that type is already on file, carrying the existing row.",
        tags: TAGS,
        body: kycSubmitSchema,
        response: kycSubmissionResponseSchema,
        status: 201,
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.submitKyc,
  );

  // ─── payments ─────────────────────────────────────────────────────
  app.post(
    "/payments/intents",
    {
      schema: routeSchema({
        summary:
          "Open a payment intent against one of the borrower's own loans. " +
          "The response's paymentUrl is where the borrower goes to pay. " +
          "`amount` is a number in; a Decimal STRING comes back. NOT " +
          "idempotent: every call opens a new intent.",
        tags: TAGS,
        /*
         * No `idempotency`, and unlike the staff-side
         * `POST /payments/intents` this route accepts no key at ALL —
         * the service mints `randomUUID()` with no caller input, so
         * there is nothing an integrator could send to make it safe. A
         * borrower double-tapping "Pay" opens two intents against the
         * same loan. Said plainly rather than omitted, because the
         * sibling staff route IS deduplicable and the asymmetry is
         * invisible from the outside.
         */
        body: intentSchema,
        response: paymentIntentResponseSchema,
        status: 201,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.createIntent,
  );
  app.get<{ Params: { id: string } }>(
    "/payments/intents/:id",
    {
      schema: routeSchema({
        summary:
          "Poll a payment intent by id or PI-number. 404 covers intents " +
          "on loans that are not the caller's.",
        tags: TAGS,
        params: portalIdParamSchema,
        response: paymentIntentResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.getIntent,
  );

  // ─── ledgers ──────────────────────────────────────────────────────
  app.get(
    "/member-ledger",
    {
      schema: routeSchema({
        summary:
          "The borrower's cooperative position: contribution/savings " +
          "totals plus the latest 20 rows of each.",
        tags: TAGS,
        response: memberLedgerResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.memberLedger,
  );
  app.get(
    "/me/ledger",
    {
      schema: routeSchema({
        summary:
          "Unified statement of account (loans + coop activity). " +
          "`?format=csv` streams CSV instead; the schema describes the " +
          "JSON shape.",
        tags: TAGS,
        querystring: ledgerQuerySchema,
        response: customerLedgerResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.customerLedger,
  );
  /*
   * No schema on me/ledger.pdf: it answers `application/pdf` bytes, and
   * routeSchema can only describe an application/json body. Publishing
   * a JSON shape it never sends — or the 204 an omitted response would
   * claim — beats nothing only if it were true.
   */
  app.get("/me/ledger.pdf", ctrl.customerLedgerPdf);

  // ─── cooperative history ──────────────────────────────────────────
  app.get(
    "/contributions",
    {
      schema: routeSchema({
        summary:
          "The borrower's own contribution rows, newest first. Fund " +
          "columns are Decimal strings. `?format=csv` streams CSV " +
          "instead; the schema describes the JSON shape.",
        tags: TAGS,
        querystring: formatQuerySchema,
        response: z.array(contributionResponseSchema),
        errors: [401, 403],
      }),
    },
    ctrl.contributions,
  );
  app.get(
    "/savings",
    {
      schema: routeSchema({
        summary:
          "The borrower's own savings transactions, newest first. " +
          "`?format=csv` streams CSV instead; the schema describes the " +
          "JSON shape.",
        tags: TAGS,
        querystring: formatQuerySchema,
        response: z.array(savingsTransactionResponseSchema),
        errors: [401, 403],
      }),
    },
    ctrl.savings,
  );
}
