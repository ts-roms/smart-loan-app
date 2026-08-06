import {
  computeAmortizationFor,
  computeFees,
  monthlyPayment,
  installmentCount,
  periodsPerYear,
} from "@loan/loans";
import {
  AuditLogRepository,
  CoMakerRepository,
  CreditScoreRepository,
  DecisionRuleRepository,
  DelegationRepository,
  KycRepository,
  LoanApprovalRepository,
  LoanDraftRepository,
  LoanNotPayableError,
  LoanRepository,
  PreAssessmentRepository,
  idOrNumberWhere,
} from "@loan/db";
import { validateKyc } from "@loan/kyc";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../../config";
import { INVITE_TTL_DAYS, mintInviteToken } from "../co-maker/consent.service";
import { sendCoMakerInvite } from "../co-maker/notify-invite";
import { LoanWorkflowController } from "./loans.controller";
import { LoanWorkflowService } from "./loans.service";
import { notifyApproversForStep } from "./notify-approvers";

// All zod request schemas live in ./schemas.ts. They're inferred here
// so request-handler bodies stay close to the wire shape without zod
// noise inside this file.
import {
  bulkPaymentSchema,
  closeEarlySchema,
  coMakerSchema,
  draftCreateSchema,
  draftUpdateSchema,
  loanListQuerySchema,
  paymentSchema,
  quoteSchema,
  restructureSchema,
  selfieMatchSchema,
  signSchema,
  waivePenaltySchema,
  writeOffSchema,
} from "./schemas";

/**
 * Per-request context for the loans feature. Built by `buildLoanCtx`
 * from `req.tenantCtx.prisma` so every repo + service touches the
 * tenant's schema.
 */
interface LoanRouteCtx {
  loans: LoanRepository;
  scores: CreditScoreRepository;
  kyc: KycRepository;
  coMakers: CoMakerRepository;
  rules: DecisionRuleRepository;
  audit: AuditLogRepository;
  delegations: DelegationRepository;
  drafts: LoanDraftRepository;
  workflowService: LoanWorkflowService;
}

declare module "fastify" {
  interface FastifyRequest {
    loanCtx?: LoanRouteCtx;
  }
}

/**
 * Loan routes. The four orchestration-heavy endpoints (apply, decide,
 * disburse, dry-run) delegate to `LoanWorkflowController`; the other
 * ~25 endpoints remain inline because they're thin repo passthroughs
 * (see docs/architecture.md — "earn its keep").
 *
 * **Phase 2 pattern**: every dependency is rebuilt per-request from
 * the tenant-scoped Prisma client (via `req.tenantCtx.prisma`). The
 * controller is a stateless singleton; inline handlers destructure
 * the per-request repos at the top so each body stays readable.
 *
 * Cost: ~10 µs of object allocation per request for the 8 repos +
 * service. Negligible against the DB roundtrip cost of any query.
 *
 * ## Authorization
 *
 * Everything here is the officer-facing surface; borrowers use
 * `/api/v1/portal/*`, which derives the customer id from the JWT
 * subject. Reads take `loans.read`, application assembly takes
 * `loans.apply`, and each workflow transition takes its own key
 * (loans.decide / disburse / restructure / write_off / …). Recording a
 * payment is `payments.record` — it creates a LoanPayment *and* posts
 * a journal entry to the general ledger, so it belongs to the
 * accountant's key set, not to whoever can read the loan.
 *
 * Two deliberate exceptions, both reachable by a CUSTOMER token:
 *
 *   • `POST /quote` — a pure amortization calculator over
 *     caller-supplied numbers plus the public product parameters. The
 *     borrower portal's apply wizard calls it on every keystroke.
 *   • `/:id/messages*` — the officer↔borrower thread, shared by
 *     LoanDetailPage and PortalLoanDetail. Gated by
 *     `requireLoanThreadAccess` below: staff need `loans.read`, a
 *     borrower needs to own the loan.
 */
export async function loanRoutes(app: FastifyInstance) {
  const workflow = new LoanWorkflowController();

  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", buildLoanCtx(app));

  const canRead = { preHandler: app.requirePermission("loans.read") };

  /**
   * Gate for the in-loan message thread, which is genuinely two-sided:
   * the officer opens it from LoanDetailPage, the borrower from
   * PortalLoanDetail, and both hit these same routes.
   *
   * Staff pass on `loans.read`. Anyone else has to prove ownership —
   * we resolve the caller's linked `Customer` from the JWT subject
   * (same derivation the portal uses; the path is never trusted) and
   * require the loan to belong to it. That closes the enumeration hole
   * without forking the endpoint in two.
   */
  const requireLoanThreadAccess = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const prisma = req.tenantCtx.prisma;
    req.permissions ??= await app.resolvePermissions(req.user.sub, prisma);
    if (req.permissions.has("loans.read")) return;

    const me = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { customerId: true },
    });
    const loan = me?.customerId
      ? await prisma.loanApplication.findFirst({
          where: idOrNumberWhere(req.params.id),
          select: { customerId: true },
        })
      : null;
    if (!loan || loan.customerId !== me!.customerId) {
      return reply.code(403).send({
        error: "Forbidden",
        message: "You do not have access to this loan.",
      });
    }
  };
  const canMessage = { preHandler: requireLoanThreadAccess };

  app.get<{ Params: { id: string } }>(
    "/:id/kyc-status",
    canRead,
    async (req, reply) => {
      const { loans, kyc } = req.loanCtx!;
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });
      const docs = await kyc.listForCustomer(loan.customerId);
      // Pull product-specific extras straight from the catalog row so brand-new
      // product codes (created at runtime) gate on their configured docs.
      const extras = (loan.product?.requiredKycDocs ?? []) as Parameters<
        typeof validateKyc
      >[1];
      return validateKyc(docs, extras);
    },
  );

  /**
   * Quote — preview the schedule + fees for a candidate application.
   * If `productCode` is given, uses that product's interest method, payment
   * frequency, and fees. Otherwise falls back to declining monthly with no fees.
   *
   * Intentionally open to any authenticated caller, borrowers included:
   * it reads nothing but the caller's own inputs and the public
   * LoanProduct parameters, and the portal apply wizard depends on it.
   */
  app.post("/quote", async (req, reply) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const { principal, termMonths, annualInterestRate, productCode } =
      parsed.data;
    const product = productCode
      ? await req.tenantCtx.prisma.loanProduct.findUnique({
          where: { code: productCode },
        })
      : null;
    const method = product?.interestMethod ?? "DECLINING";
    const frequency = product?.paymentFrequency ?? "MONTHLY";
    const schedule = computeAmortizationFor(
      principal,
      annualInterestRate,
      termMonths,
      { method, frequency },
    );
    const monthly = monthlyPayment(
      principal,
      annualInterestRate / periodsPerYear(frequency),
      installmentCount(termMonths, frequency),
    );
    const total = schedule.reduce((s, r) => s + r.payment, 0);
    const fees = product
      ? computeFees(principal, {
          processingFeeRate: Number(product.processingFeeRate),
          processingFeeFlat: Number(product.processingFeeFlat),
          documentaryStampRate: Number(product.documentaryStampRate),
        })
      : { processing: 0, documentary: 0, total: 0, netDisbursement: principal };
    return {
      monthlyPayment: monthly,
      totalPaid: Math.round(total * 100) / 100,
      totalInterest: Math.round((total - principal) * 100) / 100,
      schedule,
      fees,
      method,
      frequency,
      installments: schedule.length,
    };
  });

  /**
   * GET /loans — the master list, with optional search + filters. Every
   * parameter is optional; the bare call returns the 200 most recent, as
   * it always has.
   *
   * Filtering is server-side because the list is capped: a client-side
   * filter would only ever search the page it was given and silently miss
   * the older loan the operator went looking for.
   */
  app.get("/", canRead, async (req, reply) => {
    const parsed = loanListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.loanCtx!.loans.list(parsed.data);
  });

  // GET /loans/:idOrNumber — accept either the UUID or the human "LN-..."
  // number. The number form is what the new frontend uses on URLs; UUIDs
  // are still resolved so old bookmarks / API consumers keep working.
  app.get<{ Params: { id: string } }>("/:id", canRead, async (req, reply) => {
    const l = await req.loanCtx!.loans.findByIdOrNumber(req.params.id);
    if (!l) return reply.code(404).send({ error: "NotFound" });
    return l;
  });

  /**
   * Persist a face-match (selfie ↔ ID) score computed client-side.
   * The actual image compare runs in the browser via face-api.js so no
   * pixel data crosses our server; we only store the resulting score +
   * model identifier so officers can see it on the loan detail page and
   * so audits have a trail.
   *
   * Failed matches (passed === false) also write an audit row at action
   * LOAN_SELFIE_MATCH_FAILED with the score + model in the payload.
   */
  app.post<{ Params: { id: string } }>(
    "/:id/selfie-match",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const { loans, audit } = req.loanCtx!;
      const parsed = selfieMatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });

      const updated = await loans.setSelfieMatch(req.params.id, parsed.data);
      // Audit every match attempt — both passes and fails. Same trail
      // gives compliance a clean "we ran face-match N times" view.
      await audit.record({
        action: parsed.data.passed
          ? "LOAN_SELFIE_MATCH_PASSED"
          : "LOAN_SELFIE_MATCH_FAILED",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: req.params.id,
        payload: {
          score: parsed.data.score,
          distance: parsed.data.distance,
          model: parsed.data.model,
        },
      });
      return updated;
    },
  );

  // Delegated to LoanWorkflowController — see ./loans.service.ts for
  // the full orchestration (AML gate, decisioning, audit, anomaly,
  // approval-chain notifications).
  //
  // Borrowers submit through POST /portal/loans/apply, which forces
  // customerId to their own row; this is the officer-mediated path and
  // takes any customerId in the body, so it needs `loans.apply`.
  app.post(
    "/apply",
    { preHandler: app.requirePermission("loans.apply") },
    workflow.apply,
  );

  /**
   * Pre-decisioning preview. Mirrors the rule-evaluation slice of POST
   * /apply (lines ~233-270) but does NOT create a loan or write audit
   * rows — pure read-only. The web app calls this on the new-loan
   * dialog with the in-flight form values so the officer can see the
   * verdict + reasons (and the precise rule that fired) before
   * pressing Submit.
   *
   * Returns 200 with `{ verdict, reason, matchedRule, context, gates }`
   * even when the loan would be rejected. The `gates` object surfaces
   * blocking conditions that aren't decisioning rules (active AML
   * match, KYC incomplete) so the UI can render them as distinct
   * pre-flight checks.
   */
  // Delegated to LoanWorkflowController. Same gate as /apply — it's the
  // preview of that call and echoes back the decisioning rule that
  // would fire, which is internal underwriting policy.
  app.post(
    "/dry-run",
    { preHandler: app.requirePermission("loans.apply") },
    workflow.dryRun,
  );

  /**
   * Answer / amend the application's KYC declarations — the KYC-stage
   * capture. `kyc.submit` rather than `loans.apply`: filling in
   * compliance answers is document-gathering work, the same job as
   * uploading the ID, and belongs to the same key. Frozen once the
   * loan is decided (409) — the answers are part of what approval
   * judged.
   */
  app.put<{ Params: { id: string } }>(
    "/:id/declarations",
    { preHandler: app.requirePermission("kyc.submit") },
    workflow.answerDeclarations,
  );

  /*
   * ─── Wizard drafts ───────────────────────────────────────────────
   * The new-loan page is a 5-step wizard; officers can hit "Save draft"
   * to pause and resume later. Drafts are author-scoped (each officer
   * sees only their own) and DON'T appear in /loans — they're a
   * separate resource. On final Submit the wizard calls /apply and
   * then DELETEs the draft.
   */

  // draftCreateSchema + draftUpdateSchema are imported from ./schemas.js
  // alongside the other workflow schemas.

  app.get(
    "/drafts",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => {
      return req.loanCtx!.drafts.listByAuthor(req.user.sub);
    },
  );

  app.post(
    "/drafts",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const parsed = draftCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const draft = await req.loanCtx!.drafts.create({
        authorId: req.user.sub,
        customerId: parsed.data.customerId ?? null,
        productCode: parsed.data.productCode ?? null,
        lastStep: parsed.data.lastStep ?? 0,
        formState: parsed.data.formState,
      });
      return reply.code(201).send(draft);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/drafts/:id",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const draft = await req.loanCtx!.drafts.findByIdForAuthor(
        req.params.id,
        req.user.sub,
      );
      if (!draft) return reply.code(404).send({ error: "NotFound" });
      return draft;
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/drafts/:id",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const { drafts } = req.loanCtx!;
      const existing = await drafts.findByIdForAuthor(
        req.params.id,
        req.user.sub,
      );
      if (!existing) return reply.code(404).send({ error: "NotFound" });
      const parsed = draftUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return drafts.update(req.params.id, parsed.data);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/drafts/:id",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const { drafts } = req.loanCtx!;
      const existing = await drafts.findByIdForAuthor(
        req.params.id,
        req.user.sub,
      );
      if (!existing) return reply.code(404).send({ error: "NotFound" });
      await drafts.delete(req.params.id);
      return reply.code(204).send();
    },
  );

  // Delegated to LoanWorkflowController.
  app.post<{ Params: { id: string } }>(
    "/:id/decide",
    { preHandler: app.requirePermission("loans.decide") },
    workflow.decide,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/disburse",
    { preHandler: app.requirePermission("loans.disburse") },
    workflow.disburse,
  );

  /**
   * Record a single payment against a loan. `payments.record`, not
   * `loans.*`: recordPayment settles schedule rows AND posts the
   * corresponding journal entry to the general ledger, so it's a
   * bookkeeping write. Mirrors POST /payments/bulk, which already
   * gates on `payments.bulk`.
   */
  app.post<{ Params: { id: string } }>(
    "/:id/payments",
    { preHandler: app.requirePermission("payments.record") },
    async (req, reply) => {
      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        return reply.code(201).send(
          await req.loanCtx!.loans.recordPayment(req.params.id, {
            amount: parsed.data.amount,
            paidOn: parsed.data.paidOn
              ? new Date(parsed.data.paidOn)
              : new Date(),
            reference: parsed.data.reference,
            recordedById: req.user.sub,
          }),
        );
      } catch (err) {
        // 409, not 400: the body is fine, the loan's state forbids it.
        // Without this it surfaced as a 500, which reads as "the server
        // broke" rather than "that loan hasn't been disbursed".
        if (err instanceof LoanNotPayableError) {
          return reply.code(409).send({
            error: err.code,
            message: err.message,
            status: err.status,
          });
        }
        throw err;
      }
    },
  );

  /**
   * Bulk-record payments. Accepts up to 500 rows in one shot. Each row
   * is posted independently — partial successes are reported per-row.
   * ACCOUNTANT+ only.
   */
  app.post(
    "/payments/bulk",
    {
      preHandler: [
        app.requireFeature("bulk.payments"),
        app.requirePermission("payments.bulk"),
      ],
    },
    async (req, reply) => {
      const parsed = bulkPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const results = await req.loanCtx!.loans.recordPaymentsBulk(
        parsed.data.rows.map((r) => ({
          loanId: r.loanId,
          loanNumber: r.loanNumber,
          amount: r.amount,
          paidOn: r.paidOn ? new Date(r.paidOn) : undefined,
          reference: r.reference,
        })),
        req.user.sub,
        { stopOnError: parsed.data.stopOnError },
      );
      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.length - succeeded;
      return reply.code(207).send({ results, succeeded, failed });
    },
  );

  /**
   * Restructure: settle the original and create a replacement loan.
   * The new principal can be larger (top-up disbursement), equal
   * (rate/term change only), or smaller (partial write-down).
   */
  app.post<{ Params: { id: string } }>(
    "/:id/restructure",
    { preHandler: app.requirePermission("loans.restructure") },
    async (req, reply) => {
      const { loans, audit } = req.loanCtx!;
      const parsed = restructureSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await loans.restructure(req.params.id, {
          restructuredById: req.user.sub,
          ...parsed.data,
        });
        await audit.record({
          action: "LOAN_RESTRUCTURE",
          actorId: req.user.sub,
          targetType: "LoanApplication",
          targetId: req.params.id,
          payload: {
            replacementId: result.replacement.id,
            replacementNumber: result.replacement.number,
            newPrincipal: parsed.data.principal,
            newTerm: parsed.data.termMonths,
            newRate: parsed.data.annualInterestRate,
          },
        });
        return reply.code(201).send(result);
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  // ─── Penalty waive ─────────────────────────────────────────────────

  /** Current accrued penalty + waived-to-date totals. */
  app.get<{ Params: { id: string } }>(
    "/:id/penalties",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => req.loanCtx!.loans.accruedPenaltiesFor(req.params.id),
  );

  /** History of waivers on this loan (drawer audit trail). */
  app.get<{ Params: { id: string } }>(
    "/:id/penalty-waivers",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => req.loanCtx!.loans.listPenaltyWaivers(req.params.id),
  );

  /** Waive part or all of the outstanding penalty. Posts the reversal. */
  app.post<{ Params: { id: string } }>(
    "/:id/waive-penalty",
    { preHandler: app.requirePermission("loans.waive_penalty") },
    async (req, reply) => {
      const { loans, audit } = req.loanCtx!;
      const parsed = waivePenaltySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await loans.waivePenalty(req.params.id, {
          waivedAmount: parsed.data.waivedAmount,
          reason: parsed.data.reason,
          waivedById: req.user.sub,
        });
        await audit.record({
          action: "PENALTY_WAIVE",
          actorId: req.user.sub,
          targetType: "LoanApplication",
          targetId: req.params.id,
          payload: {
            waivedAmount: parsed.data.waivedAmount,
            reason: parsed.data.reason,
            waiverId: result.waiver.id,
            journalEntryId: result.journalEntryId,
          },
        });
        return reply.code(201).send(result);
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  /** Write off the loan — books bad debt for the remaining principal. */
  app.post<{ Params: { id: string } }>(
    "/:id/write-off",
    { preHandler: app.requirePermission("loans.write_off") },
    async (req, reply) => {
      const { loans, audit } = req.loanCtx!;
      const parsed = writeOffSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await loans.writeOff(req.params.id, {
          writtenOffById: req.user.sub,
          reason: parsed.data.reason,
        });
        await audit.record({
          action: "LOAN_WRITE_OFF",
          actorId: req.user.sub,
          targetType: "LoanApplication",
          targetId: req.params.id,
          payload: { amount: result.amount, reason: parsed.data.reason },
        });
        return reply.code(201).send(result);
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  // ─── E-signatures ──────────────────────────────────────────────────

  /**
   * Officer signs the loan agreement. Records the signature URL, timestamp,
   * and (best-effort) the SHA-256 of the agreement PDF at signing time so
   * future tamper-detection is possible.
   */
  app.post<{ Params: { id: string } }>(
    "/:id/sign-officer",
    async (req, reply) => {
      const { delegations, audit } = req.loanCtx!;
      const parsed = signSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }

      // The caller needs `loans.sign_officer` — either directly (via their
      // own roles) or inherited through an active delegation. We rely on the
      // effective-permissions resolver to have already unioned delegated
      // permissions onto req.permissions.
      const callerPerms =
        req.permissions ??
        (await app.resolvePermissions(req.user.sub, req.tenantCtx.prisma));
      if (!callerPerms.has("loans.sign_officer")) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "You do not have permission to sign loans as officer.",
        });
      }

      // If signing under a specific delegation, validate it: the delegation
      // must currently be active for this caller, not revoked, and either
      // blanket (empty permissions[]) or explicitly grant loans.sign_officer.
      // We persist the delegation id on the loan so the audit trail records
      // *which* proxy authority was used.
      let delegationId: string | null = null;
      if (parsed.data.delegationId) {
        const d = await delegations.findById(parsed.data.delegationId);
        const now = new Date();
        const active =
          d &&
          d.delegateId === req.user.sub &&
          d.revokedAt === null &&
          d.startsAt <= now &&
          d.endsAt >= now;
        const grantsSign =
          d &&
          (d.permissions.length === 0 ||
            d.permissions.includes("loans.sign_officer"));
        if (!active || !grantsSign) {
          return reply.code(403).send({
            error: "Forbidden",
            message:
              "Delegation is not active or does not grant loans.sign_officer.",
          });
        }
        delegationId = d.id;
      }

      const loan = await req.tenantCtx.prisma.loanApplication.update({
        where: { id: req.params.id },
        data: {
          officerSignatureUrl: parsed.data.signatureUrl,
          officerSignedAt: new Date(),
          officerSignedById: req.user.sub,
          officerSignedUnderDelegationId: delegationId,
        },
      });
      await audit.record({
        action: "LOAN_SIGNED_OFFICER",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: loan.id,
        payload: {
          signatureUrl: parsed.data.signatureUrl,
          delegationId,
        },
      });
      return loan;
    },
  );

  /**
   * Borrower signs (officer-mediated path — useful for in-branch signing).
   * The portal mirror under /portal/loans/:id/sign-borrower is what
   * customers actually call from their device.
   */
  app.post<{ Params: { id: string } }>(
    "/:id/sign-borrower",
    { preHandler: app.requirePermission("loans.sign_officer") },
    async (req, reply) => {
      const { audit } = req.loanCtx!;
      const parsed = signSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ?? req.ip;
      const loan = await req.tenantCtx.prisma.loanApplication.update({
        where: { id: req.params.id },
        data: {
          borrowerSignatureUrl: parsed.data.signatureUrl,
          borrowerSignedAt: new Date(),
          borrowerSignedFromIp: ip,
        },
      });
      await audit.record({
        action: "LOAN_SIGNED_BORROWER",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: loan.id,
        payload: {
          signatureUrl: parsed.data.signatureUrl,
          ip,
          mediatedBy: req.user.sub,
        },
      });
      return loan;
    },
  );

  // ─── Co-makers ─────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/:id/co-makers", canRead, async (req) =>
    // With consent state + attachments — the officer view needs both.
    req.loanCtx!.coMakers.listForLoanWithDocuments(req.params.id),
  );

  // Adding a co-maker is part of assembling the application file, so it
  // rides `loans.apply`. (The DELETE below predates this pass and keeps
  // `loans.decide`; both keys belong to LOAN_OFFICER + ADMIN, so the
  // difference is one of intent, not of reach.)
  app.post<{ Params: { id: string } }>(
    "/:id/co-makers",
    { preHandler: app.requirePermission("loans.apply") },
    async (req, reply) => {
      const parsed = coMakerSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return reply
        .code(201)
        .send(await req.loanCtx!.coMakers.create(req.params.id, parsed.data));
    },
  );

  /**
   * Mint (or replace) a co-maker's invite link.
   *
   * Returns the URL rather than sending it: who delivers it — SMS,
   * email, or the officer reading it out — isn't settled, and a link
   * the officer can copy works today under all three. Resending
   * invalidates the previous link and clears any previous answer, so
   * a co-maker who declined can be asked again without that decline
   * lingering on the record.
   */
  app.post<{ Params: { coMakerId: string } }>(
    "/co-makers/:coMakerId/invite",
    { preHandler: app.requirePermission("loans.apply") },
    async (req, reply) => {
      const token = mintInviteToken(req.tenantCtx.slug);
      const expiresAt = new Date(
        Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      let coMaker;
      try {
        coMaker = await req.loanCtx!.coMakers.issueInvite(
          req.params.coMakerId,
          token,
          expiresAt,
        );
      } catch {
        return reply.code(404).send({ error: "NotFound" });
      }

      const url = `${config.webOrigin}/co-maker/${token}`;
      const delivery = await sendCoMakerInvite({
        prisma: req.tenantCtx.prisma,
        notifications: app.notifications(req.tenantCtx.prisma),
        coMaker,
        url,
        log: app.log,
      });

      // The URL comes back either way. Delivery is best-effort — an
      // SMS provider being down shouldn't cost the officer the link,
      // and `delivery` tells the UI whether to say "sent" or "copy
      // this to them".
      return { url, expiresAt: expiresAt.toISOString(), delivery };
    },
  );

  /**
   * Revoke a co-maker's invite link — the co-maker half of force
   * logout.
   *
   * They have no account, so there is no session to end; the link IS
   * the access. Killing the token is immediate in a way the staff-side
   * equivalent can't be, because every load of the consent page
   * resolves the token against the database rather than trusting a
   * signature.
   *
   * Gated on `admin.force_logout` rather than `loans.apply`, matching
   * the user endpoint: this is a "cut off access now" action, and it
   * should be reachable by whoever holds that during an incident even
   * if they don't work loan files.
   */
  app.post<{ Params: { coMakerId: string } }>(
    "/co-makers/:coMakerId/revoke-invite",
    { preHandler: app.requirePermission("admin.force_logout") },
    async (req, reply) => {
      const existing = await req.tenantCtx.prisma.coMaker.findUnique({
        where: { id: req.params.coMakerId },
        select: { id: true, fullName: true, loanId: true, inviteToken: true },
      });
      if (!existing) return reply.code(404).send({ error: "NotFound" });

      // Already revoked, never invited, or expired-and-cleared. Report
      // success rather than 409: the caller asked for this link to stop
      // working and it doesn't work. An error here would read as "the
      // co-maker still has access", which is the opposite of the truth.
      const hadToken = existing.inviteToken !== null;
      const coMaker = await req.loanCtx!.coMakers.revokeInvite(existing.id);

      await req.loanCtx!.audit.record({
        action: "CO_MAKER_INVITE_REVOKED",
        actorId: req.user.sub,
        targetType: "CoMaker",
        targetId: existing.id,
        payload: {
          loanId: existing.loanId,
          fullName: existing.fullName,
          hadActiveLink: hadToken,
        },
      });

      return { ok: true, hadActiveLink: hadToken, coMaker };
    },
  );

  app.delete<{ Params: { coMakerId: string } }>(
    "/co-makers/:coMakerId",
    { preHandler: app.requirePermission("loans.decide") },
    async (req) => req.loanCtx!.coMakers.delete(req.params.coMakerId),
  );

  // ─── In-app messaging (officer ↔ borrower) ─────────────────────────

  app.get<{ Params: { id: string } }>(
    "/:id/messages",
    canMessage,
    async (req) =>
      req.tenantCtx.prisma.loanMessage.findMany({
        where: { loanId: req.params.id },
        orderBy: { createdAt: "asc" },
      }),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/:id/messages",
    canMessage,
    async (req, reply) => {
      const body = (req.body?.body ?? "").trim();
      if (!body || body.length > 2000) {
        return reply.code(400).send({
          error: "BadRequest",
          message: "body must be 1–2000 chars",
        });
      }
      // Author role is captured at send time so a later role change
      // doesn't rewrite the conversation's history.
      const me = await req.tenantCtx.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { role: true },
      });
      const authorRole = me?.role === "CUSTOMER" ? "BORROWER" : "OFFICER";
      const msg = await req.tenantCtx.prisma.loanMessage.create({
        data: {
          loanId: req.params.id,
          authorId: req.user.sub,
          authorRole,
          body,
        },
      });
      return reply.code(201).send(msg);
    },
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    "/:id/messages/:messageId/read",
    canMessage,
    async (req, reply) => {
      // Scope the update by loanId as well as messageId: `canMessage`
      // authorized the caller for `:id`, so the row being marked read
      // has to actually belong to that loan.
      const { count } = await req.tenantCtx.prisma.loanMessage.updateMany({
        where: { id: req.params.messageId, loanId: req.params.id },
        data: { readAt: new Date() },
      });
      if (count === 0) return reply.code(404).send({ error: "NotFound" });
      return req.tenantCtx.prisma.loanMessage.findUnique({
        where: { id: req.params.messageId },
      });
    },
  );

  /** Settle the loan early with the product's pre-termination fee. */
  app.post<{ Params: { id: string } }>(
    "/:id/close-early",
    { preHandler: app.requirePermission("loans.close_early") },
    async (req, reply) => {
      const parsed = closeEarlySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        return await req.loanCtx!.loans.closeEarly(req.params.id, {
          settlementAmount: parsed.data.settlementAmount,
          reference: parsed.data.reference,
          closedById: req.user.sub,
        });
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );
}

/**
 * Per-request context builder. Constructs every repo + the workflow
 * service against the tenant-scoped Prisma client and stashes them
 * on `req.loanCtx`.
 *
 * Object allocation is cheap (~10 µs total); the alternative — letting
 * services capture `app.prisma` at boot — leaks across tenants and is
 * the whole reason Phase 2 exists.
 */
function buildLoanCtx(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    const prisma = req.tenantCtx.prisma;
    const loans = new LoanRepository(prisma);
    const scores = new CreditScoreRepository(prisma);
    const kyc = new KycRepository(prisma);
    const coMakers = new CoMakerRepository(prisma);
    const rules = new DecisionRuleRepository(prisma);
    const audit = new AuditLogRepository(prisma, req.user?.impersonatedBy);
    const delegations = new DelegationRepository(prisma);
    const drafts = new LoanDraftRepository(prisma);
    const notifications = app.notifications(prisma);
    const workflowService = new LoanWorkflowService(
      loans,
      scores,
      kyc,
      rules,
      audit,
      prisma,
      app.screening(prisma),
      notifications,
      app.log,
      // Bind the Fastify instance + per-request prisma + notifications
      // into a function shape so the workflow service doesn't have to
      // know about any of those.
      (loanId, stepOrder) =>
        notifyApproversForStep(app, prisma, notifications, loanId, stepOrder),
      new PreAssessmentRepository(prisma),
      // Consent gate on disburse — see LoanWorkflowService.disburse.
      coMakers,
      // Approval chain, for the gate in decide().
      new LoanApprovalRepository(prisma),
    );
    req.loanCtx = {
      loans,
      scores,
      kyc,
      coMakers,
      rules,
      audit,
      delegations,
      drafts,
      workflowService,
    };
  };
}
