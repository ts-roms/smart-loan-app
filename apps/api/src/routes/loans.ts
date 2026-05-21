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
  LoanDraftRepository,
  LoanRepository,
} from "@loan/db";
import { validateKyc } from "@loan/kyc";
import { evaluateRules, type DecisioningContext } from "@loan/decisioning";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { computeAnomalyFlags } from "../lib/anomaly.js";
import { notifyApproversForStep } from "./loan-approvals.js";

const vehicleSchema = z.object({
  kind: z.enum(["CAR", "MOTORCYCLE"]),
  make: z.string().min(1).max(80),
  model: z.string().min(1).max(80),
  year: z.number().int().min(1900).max(2100),
  plateNumber: z.string().max(40).optional(),
  chassisNumber: z.string().max(80).optional(),
  engineNumber: z.string().max(80).optional(),
  color: z.string().max(40).optional(),
  appraisedValue: z.number().positive(),
  notes: z.string().max(500).optional(),
});

const propertySchema = z.object({
  propertyType: z.string().min(1).max(80),
  address: z.string().min(1).max(500),
  city: z.string().min(1).max(80),
  province: z.string().max(80).optional(),
  postalCode: z.string().max(20).optional(),
  titleNumber: z.string().max(80).optional(),
  taxDecNumber: z.string().max(80).optional(),
  areaSqm: z.number().positive().optional(),
  appraisedValue: z.number().positive(),
  notes: z.string().max(500).optional(),
});

const applySchema = z.object({
  customerId: z.string().uuid(),
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: vehicleSchema.optional(),
  property: propertySchema.optional(),
  /** Selfie URL captured at apply time (uploaded via /uploads-api/selfies). */
  applicationSelfieUrl: z.string().max(500).optional(),
});

const decideSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().max(500).optional(),
  overrideKyc: z.boolean().optional(),
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  paidOn: z.string().optional(),
  reference: z.string().max(120).optional(),
});

const bulkPaymentRowSchema = z
  .object({
    loanNumber: z.string().optional(),
    loanId: z.string().uuid().optional(),
    amount: z.number().positive(),
    paidOn: z.string().optional(),
    reference: z.string().max(120).optional(),
  })
  .refine((r) => Boolean(r.loanId || r.loanNumber), {
    message: "Each row needs loanId or loanNumber",
    path: ["loanNumber"],
  });

const bulkPaymentSchema = z.object({
  rows: z.array(bulkPaymentRowSchema).min(1).max(500),
  stopOnError: z.boolean().optional(),
});

const closeEarlySchema = z.object({
  settlementAmount: z.number().positive(),
  reference: z.string().max(120).optional(),
});

const restructureSchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive(),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
});

const waivePenaltySchema = z.object({
  waivedAmount: z.number().positive(),
  reason: z.string().min(3).max(500),
});

const writeOffSchema = z.object({
  reason: z.string().min(1).max(500),
});

const signSchema = z.object({
  /**
   * Signature image URL (e.g. /uploads/signatures/abc.png). Caller uploads
   * via /uploads-api/signatures first, then posts the URL here.
   */
  signatureUrl: z.string().min(1).max(500),
  /**
   * Optional — when signing under a proxy authority. The delegation must be
   * active, granted to the caller, and either be a "blanket" delegation
   * (empty permissions[]) or explicitly include `loans.sign_officer`.
   */
  delegationId: z.string().uuid().optional(),
});

const coMakerSchema = z.object({
  fullName: z.string().min(1).max(200),
  role: z.enum(["CO_BORROWER", "GUARANTOR", "CO_MAKER"]).optional(),
  relationship: z.string().max(80).optional(),
  phone: z.string().min(1).max(40),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
  governmentIdType: z
    .enum(["PASSPORT", "DRIVERS_LICENSE", "NATIONAL_ID", "SSS", "TIN", "OTHER"])
    .optional(),
  governmentIdNumber: z.string().max(60).optional(),
  monthlyIncome: z.number().nonnegative().optional(),
  signedAgreementUrl: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

const quoteSchema = z.object({
  principal: z.number().positive(),
  termMonths: z.number().int().positive(),
  annualInterestRate: z.number().min(0).max(1),
  productCode: z.string().optional(),
});

export async function loanRoutes(app: FastifyInstance) {
  const loans = new LoanRepository(app.prisma);
  const scores = new CreditScoreRepository(app.prisma);
  const kyc = new KycRepository(app.prisma);
  const coMakers = new CoMakerRepository(app.prisma);
  const rules = new DecisionRuleRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);
  const delegations = new DelegationRepository(app.prisma);
  const drafts = new LoanDraftRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get<{ Params: { id: string } }>("/:id/kyc-status", async (req, reply) => {
    const loan = await loans.findByIdOrNumber(req.params.id);
    if (!loan) return reply.code(404).send({ error: "NotFound" });
    const docs = await kyc.listForCustomer(loan.customerId);
    // Pull product-specific extras straight from the catalog row so brand-new
    // product codes (created at runtime) gate on their configured docs.
    const extras = (loan.product?.requiredKycDocs ?? []) as Parameters<
      typeof validateKyc
    >[1];
    return validateKyc(docs, extras);
  });

  /**
   * Quote — preview the schedule + fees for a candidate application.
   * If `productCode` is given, uses that product's interest method, payment
   * frequency, and fees. Otherwise falls back to declining monthly with no fees.
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
      ? await app.prisma.loanProduct.findUnique({
          where: { code: productCode },
        })
      : null;
    const method = (product?.interestMethod ?? "DECLINING") as
      | "DECLINING"
      | "FLAT";
    const frequency = (product?.paymentFrequency ?? "MONTHLY") as
      | "MONTHLY"
      | "BIWEEKLY"
      | "WEEKLY";
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

  app.get("/", async () => loans.list());

  // GET /loans/:idOrNumber — accept either the UUID or the human "LN-..."
  // number. The number form is what the new frontend uses on URLs; UUIDs
  // are still resolved so old bookmarks / API consumers keep working.
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const l = await loans.findByIdOrNumber(req.params.id);
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
  const selfieMatchSchema = z.object({
    score: z.number().min(0).max(1),
    distance: z.number().min(0).max(2),
    passed: z.boolean(),
    model: z.string().min(1).max(80),
  });
  app.post<{ Params: { id: string } }>(
    "/:id/selfie-match",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
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

  app.post("/apply", async (req, reply) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    // AML gate: an active MATCH blocks apply outright. ADMIN can override
    // separately via /screening/customers/:id/override, which posts an
    // OVERRIDDEN row that supersedes the MATCH.
    const latestScreen = await app.screening.latestForCustomer(
      parsed.data.customerId,
    );
    if (latestScreen?.status === "MATCH") {
      return reply.code(409).send({
        error: "AmlBlocked",
        message: "Customer has an unresolved AML match. Override required.",
        screeningId: latestScreen.id,
      });
    }
    const score = await scores.latestForCustomer(parsed.data.customerId);

    // Evaluate decisioning rules against the applicant context.
    const customer = await app.prisma.customer.findUnique({
      where: { id: parsed.data.customerId },
    });
    const docs = await kyc.listForCustomer(parsed.data.customerId);
    const product = await app.prisma.loanProduct.findUnique({
      where: { code: parsed.data.productCode },
    });
    const extras = (product?.requiredKycDocs ?? []) as Parameters<
      typeof validateKyc
    >[1];
    const kycRes = validateKyc(docs, extras);
    const activeLoans = await app.prisma.loanApplication.count({
      where: {
        customerId: parsed.data.customerId,
        status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
      },
    });
    const customerAge = customer
      ? Math.floor(
          (Date.now() - customer.dateOfBirth.getTime()) / (365.25 * 86_400_000),
        )
      : 0;
    const decisioningCtx: DecisioningContext = {
      productCode: parsed.data.productCode,
      principal: parsed.data.principal,
      termMonths: parsed.data.termMonths,
      annualInterestRate: parsed.data.annualInterestRate,
      tierAtApply: score?.tier ?? null,
      creditScoreAtApply: score?.score ?? null,
      amlStatus: latestScreen?.status ?? null,
      kycComplete: kycRes.complete,
      customerAge,
      monthlyIncome: customer ? Number(customer.monthlyIncome) : 0,
      existingActiveLoans: activeLoans,
    };
    const ruleRows = await rules.listActive();
    const decision = evaluateRules(rules.toEvaluable(ruleRows), decisioningCtx);
    const initialStatus: "SUBMITTED" | "APPROVED" | "REJECTED" =
      decision.action === "AUTO_APPROVE"
        ? "APPROVED"
        : decision.action === "AUTO_REJECT"
          ? "REJECTED"
          : "SUBMITTED";

    try {
      const created = await loans.apply({
        ...parsed.data,
        submittedById: req.user.sub,
        creditScoreAtApply: score?.score ?? null,
        tierAtApply: score?.tier ?? null,
        initialStatus,
        initialDecisionReason:
          initialStatus === "SUBMITTED" ? undefined : decision.reason,
      });
      if (decision.matched) {
        await audit.record({
          action: `LOAN_AUTO_${decision.action}`,
          actorId: req.user.sub,
          targetType: "LoanApplication",
          targetId: created.id,
          payload: {
            rule: decision.matched.name,
            reason: decision.reason,
            context: decisioningCtx,
          },
        });
      }

      // Anomaly flagging runs after the loan is persisted so audit
      // log rows reference the created loan id. Best-effort: never
      // block the 201 — if the helper throws, log + continue.
      try {
        const anomalies = await computeAnomalyFlags(app.prisma, {
          customerId: parsed.data.customerId,
          productCode: parsed.data.productCode,
          principal: parsed.data.principal,
          termMonths: parsed.data.termMonths,
          annualInterestRate: parsed.data.annualInterestRate,
          monthlyIncome: customer ? Number(customer.monthlyIncome) : 0,
        });
        // Only audit medium/high — low-severity flags (e.g. INSUFFICIENT_BASELINE)
        // are noise in the log.
        const actionable = anomalies.filter(
          (a) => a.severity === "medium" || a.severity === "high",
        );
        if (actionable.length > 0) {
          await audit.record({
            action: "LOAN_APPLICATION_FLAGGED",
            actorId: req.user.sub,
            targetType: "LoanApplication",
            targetId: created.id,
            payload: { anomalies: actionable },
          });
        }
      } catch (err) {
        app.log.warn(
          { err, loanId: created.id },
          "anomaly flagger failed; loan apply continued",
        );
      }
      // If the product has an approval chain configured, fan-out a
      // "you have a loan to approve" notification to the step-1
      // approvers. Detected via currentApprovalStep being set — null
      // means legacy single-decide flow, no notification needed.
      if (created.currentApprovalStep) {
        void notifyApproversForStep(
          app,
          created.id,
          created.currentApprovalStep,
        );
      }
      return reply.code(201).send({ ...created, decision });
    } catch (err) {
      const e = err as Error & { issues?: unknown };
      return reply.code(400).send({
        error: "BadRequest",
        message: e.message,
        issues: e.issues,
      });
    }
  });

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
  app.post("/dry-run", async (req, reply) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }

    // Pull the same context as /apply. Each lookup is cheap; we do
    // them in parallel where possible to keep the round-trip snappy
    // (this endpoint is hit on every form-edit debounce).
    const [latestScreen, score, customer, docs, product, activeLoans] =
      await Promise.all([
        app.screening.latestForCustomer(parsed.data.customerId),
        scores.latestForCustomer(parsed.data.customerId),
        app.prisma.customer.findUnique({
          where: { id: parsed.data.customerId },
        }),
        kyc.listForCustomer(parsed.data.customerId),
        app.prisma.loanProduct.findUnique({
          where: { code: parsed.data.productCode },
        }),
        app.prisma.loanApplication.count({
          where: {
            customerId: parsed.data.customerId,
            status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
          },
        }),
      ]);

    if (!customer) {
      return reply.code(404).send({ error: "CustomerNotFound" });
    }

    const extras = (product?.requiredKycDocs ?? []) as Parameters<
      typeof validateKyc
    >[1];
    const kycRes = validateKyc(docs, extras);
    const customerAge = Math.floor(
      (Date.now() - customer.dateOfBirth.getTime()) / (365.25 * 86_400_000),
    );

    const decisioningCtx: DecisioningContext = {
      productCode: parsed.data.productCode,
      principal: parsed.data.principal,
      termMonths: parsed.data.termMonths,
      annualInterestRate: parsed.data.annualInterestRate,
      tierAtApply: score?.tier ?? null,
      creditScoreAtApply: score?.score ?? null,
      amlStatus: latestScreen?.status ?? null,
      kycComplete: kycRes.complete,
      customerAge,
      monthlyIncome: Number(customer.monthlyIncome),
      existingActiveLoans: activeLoans,
    };

    const ruleRows = await rules.listActive();
    const decision = evaluateRules(rules.toEvaluable(ruleRows), decisioningCtx);

    // Map decisioning action to a UI-friendly verdict. AUTO_REVIEW
    // becomes MANUAL_REVIEW so the UI can color-code consistently.
    const verdict: "APPROVE" | "REVIEW" | "REJECT" =
      decision.action === "AUTO_APPROVE"
        ? "APPROVE"
        : decision.action === "AUTO_REJECT"
          ? "REJECT"
          : "REVIEW";

    // Surface non-rule gating conditions the UI should render
    // separately. These DON'T necessarily reject — apply() returns 409
    // for AML, and decide() blocks on KYC — but the officer should see
    // them ahead of time.
    const gates = {
      amlMatch: latestScreen?.status === "MATCH",
      kycComplete: kycRes.complete,
      missingKycDocs: kycRes.missing,
      rejectedKycDocs: kycRes.rejected,
    };

    // Statistical + heuristic anomaly detection. Pure read; never
    // blocks. Surfaces alongside the verdict so the officer sees
    // "this loan is fine per rules, but the principal is 4σ above
    // average — verify the income docs" in one panel.
    const anomalies = await computeAnomalyFlags(app.prisma, {
      customerId: parsed.data.customerId,
      productCode: parsed.data.productCode,
      principal: parsed.data.principal,
      termMonths: parsed.data.termMonths,
      annualInterestRate: parsed.data.annualInterestRate,
      monthlyIncome: Number(customer.monthlyIncome),
    });

    return {
      verdict,
      reason: decision.reason,
      matchedRule: decision.matched
        ? { id: decision.matched.id, name: decision.matched.name }
        : null,
      gates,
      anomalies,
      context: {
        principal: parsed.data.principal,
        termMonths: parsed.data.termMonths,
        annualInterestRate: parsed.data.annualInterestRate,
        productCode: parsed.data.productCode,
        creditScore: decisioningCtx.creditScoreAtApply,
        tier: decisioningCtx.tierAtApply,
        monthlyIncome: decisioningCtx.monthlyIncome,
        existingActiveLoans: decisioningCtx.existingActiveLoans,
      },
    };
  });

  /*
   * ─── Wizard drafts ───────────────────────────────────────────────
   * The new-loan page is a 5-step wizard; officers can hit "Save draft"
   * to pause and resume later. Drafts are author-scoped (each officer
   * sees only their own) and DON'T appear in /loans — they're a
   * separate resource. On final Submit the wizard calls /apply and
   * then DELETEs the draft.
   */

  const draftCreateSchema = z.object({
    customerId: z.string().uuid().optional().nullable(),
    productCode: z.string().min(1).max(40).optional().nullable(),
    lastStep: z.number().int().min(0).max(20).optional(),
    // formState is owned by the wizard — we accept any JSON shape.
    // Final-submit validation happens against applySchema separately.
    formState: z.unknown(),
  });
  const draftUpdateSchema = draftCreateSchema.partial();

  app.get(
    "/drafts",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => {
      return drafts.listByAuthor(req.user.sub);
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
      const draft = await drafts.create({
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
      const draft = await drafts.findByIdForAuthor(req.params.id, req.user.sub);
      if (!draft) return reply.code(404).send({ error: "NotFound" });
      return draft;
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/drafts/:id",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
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
      const existing = await drafts.findByIdForAuthor(
        req.params.id,
        req.user.sub,
      );
      if (!existing) return reply.code(404).send({ error: "NotFound" });
      await drafts.delete(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/:id/decide", async (req, reply) => {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }

    let reason = parsed.data.reason;
    if (parsed.data.status === "APPROVED") {
      const loan = await loans.findByIdOrNumber(req.params.id);
      if (!loan) return reply.code(404).send({ error: "NotFound" });
      const docs = await kyc.listForCustomer(loan.customerId);
      const extras = (loan.product?.requiredKycDocs ?? []) as Parameters<
        typeof validateKyc
      >[1];
      const kycResult = validateKyc(docs, extras);
      if (!kycResult.complete) {
        if (!parsed.data.overrideKyc) {
          return reply.code(409).send({
            error: "KycIncomplete",
            message: `Cannot approve ${loan.productCode} loan — KYC incomplete.`,
            missing: kycResult.missing,
            rejected: kycResult.rejected,
            status: kycResult.status,
          });
        }
        const note = `[KYC override: missing=${kycResult.missing.join(",") || "none"}, rejected=${kycResult.rejected.join(",") || "none"}]`;
        reason = reason ? `${reason} ${note}` : note;
      }
    }

    return loans.decide(req.params.id, {
      status: parsed.data.status,
      reason,
      decidedById: req.user.sub,
    });
  });

  app.post<{ Params: { id: string } }>("/:id/disburse", async (req) => {
    const disbursed = await loans.disburse(req.params.id, {
      disbursedById: req.user.sub,
    });
    // Best-effort notification to the borrower.
    try {
      const loan = await loans.findById(disbursed.id);
      const c = loan?.customer;
      const firstSchedule = loan?.schedule?.[0];
      if (loan && c && c.email) {
        await app.notifications.dispatch({
          event: "LOAN_DISBURSED",
          channel: "EMAIL",
          recipient: c.email,
          data: {
            customerName: `${c.firstName} ${c.lastName}`,
            loanNumber: loan.number,
            amount: Number(loan.principal),
            dueDate: firstSchedule
              ? new Date(firstSchedule.dueDate).toISOString().slice(0, 10)
              : "",
          },
          refType: "LoanApplication",
          refId: loan.id,
          customerId: c.id,
        });
      }
    } catch {
      // Non-fatal.
    }
    return disbursed;
  });

  app.post<{ Params: { id: string } }>("/:id/payments", async (req, reply) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await loans.recordPayment(req.params.id, {
        amount: parsed.data.amount,
        paidOn: parsed.data.paidOn ? new Date(parsed.data.paidOn) : new Date(),
        reference: parsed.data.reference,
        recordedById: req.user.sub,
      }),
    );
  });

  /**
   * Bulk-record payments. Accepts up to 500 rows in one shot. Each row
   * is posted independently — partial successes are reported per-row.
   * ACCOUNTANT+ only.
   */
  app.post(
    "/payments/bulk",
    { preHandler: app.requirePermission("payments.bulk") },
    async (req, reply) => {
      const parsed = bulkPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const results = await loans.recordPaymentsBulk(
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

  // ─── Penalty waive (FRD §3.3) ──────────────────────────────────────

  /** Current accrued penalty + waived-to-date totals. */
  app.get<{ Params: { id: string } }>(
    "/:id/penalties",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => loans.accruedPenaltiesFor(req.params.id),
  );

  /** History of waivers on this loan (drawer audit trail). */
  app.get<{ Params: { id: string } }>(
    "/:id/penalty-waivers",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => loans.listPenaltyWaivers(req.params.id),
  );

  /** Waive part or all of the outstanding penalty. Posts the reversal. */
  app.post<{ Params: { id: string } }>(
    "/:id/waive-penalty",
    { preHandler: app.requirePermission("loans.waive_penalty") },
    async (req, reply) => {
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
        req.permissions ?? (await app.resolvePermissions(req.user.sub));
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
        delegationId = d!.id;
      }

      const loan = await app.prisma.loanApplication.update({
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
      const loan = await app.prisma.loanApplication.update({
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

  app.get<{ Params: { id: string } }>("/:id/co-makers", async (req) =>
    coMakers.listForLoan(req.params.id),
  );

  app.post<{ Params: { id: string } }>("/:id/co-makers", async (req, reply) => {
    const parsed = coMakerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply
      .code(201)
      .send(await coMakers.create(req.params.id, parsed.data));
  });

  app.delete<{ Params: { coMakerId: string } }>(
    "/co-makers/:coMakerId",
    { preHandler: app.requirePermission("loans.decide") },
    async (req) => coMakers.delete(req.params.coMakerId),
  );

  // ─── In-app messaging (officer ↔ borrower) ─────────────────────────

  app.get<{ Params: { id: string } }>("/:id/messages", async (req) =>
    app.prisma.loanMessage.findMany({
      where: { loanId: req.params.id },
      orderBy: { createdAt: "asc" },
    }),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/:id/messages",
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
      const me = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { role: true },
      });
      const authorRole = me?.role === "CUSTOMER" ? "BORROWER" : "OFFICER";
      const msg = await app.prisma.loanMessage.create({
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
    async (req) =>
      app.prisma.loanMessage.update({
        where: { id: req.params.messageId },
        data: { readAt: new Date() },
      }),
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
        return await loans.closeEarly(req.params.id, {
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
