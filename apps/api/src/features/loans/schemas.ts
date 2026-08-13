// The phone helpers went with the co-maker identity fields — a
// co-maker's number now comes from their Customer row, where it was
// already validated on the way in.
import { z } from "zod";

/**
 * Zod schemas for the loans surface. Extracted from loans.routes.ts so
 * the route file stays focused on HTTP wiring; the validation contract
 * lives here and can be unit-tested or reused (e.g. by a future
 * bulk-loan importer) without dragging the whole route file along.
 *
 * Each export is named after the action it gates so the call-site
 * reads naturally: `applySchema.safeParse(req.body)`.
 */

// ─── Collateral sub-schemas ─────────────────────────────────────────────

/**
 * Vehicle collateral. Bound on the same shape the Prisma `Vehicle`
 * model exposes; the route layer hands this directly to the repository.
 */
export const vehicleSchema = z.object({
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

/** Real-property collateral (TCT-bound or tax-dec-only). */
export const propertySchema = z.object({
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

// ─── Loan workflow ──────────────────────────────────────────────────────

/**
 * Apply for a new loan. `applicationSelfieUrl` is captured at apply
 * time (uploaded via /uploads-api/selfies) and embedded in the
 * agreement PDF for face-match.
 */
/**
 * Query-string for GET /loans. Every field optional — the bare endpoint
 * keeps returning the 200 most recent.
 *
 * `page` and `pageSize` are coerced because query strings are always
 * text, and are left loosely bounded here because the repository clamps
 * them anyway: a stale `?page=0` bookmark should land on page 1, not on
 * a 400.
 */
export const loanListQuerySchema = z.object({
  /** Free text over the loan number and the borrower's name / reference. */
  q: z.string().max(120).optional(),
  status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "REJECTED",
      "DISBURSED",
      "ACTIVE",
      "CLOSED",
      "DEFAULTED",
      "CANCELLED",
      "RESTRUCTURED",
      "WRITTEN_OFF",
    ])
    .optional(),
  productCode: z.string().max(40).optional(),
  /** Scope to one borrower — the customer profile's loan history. */
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});
export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

export const applySchema = z.object({
  customerId: z.string().uuid(),
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: vehicleSchema.optional(),
  property: propertySchema.optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
  /**
   * The pre-assessment this application came out of, if any. Linking is
   * best-effort and never blocks the apply — see LoanWorkflowService.
   */
  preAssessmentId: z.string().uuid().optional(),
  /**
   * Answers to the product's KYC declaration questionnaire, keyed by
   * question id. Partial is fine — completeness gates APPROVAL, not
   * submission — but every answer present must fit its question's type
   * (validated in the service against the product's questions).
   */
  kycAnswers: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

/** Body of PUT /loans/:id/declarations — the KYC-stage answer/edit. */
export const declarationAnswersSchema = z.object({
  answers: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type DeclarationAnswersInput = z.infer<typeof declarationAnswersSchema>;

export const decideSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().max(500).optional(),
  overrideKyc: z.boolean().optional(),
});

/** Single payment against a loan. `paidOn` defaults to today server-side. */
export const paymentSchema = z.object({
  amount: z.number().positive(),
  paidOn: z.string().optional(),
  reference: z.string().max(120).optional(),
  /**
   * Idempotency key, for callers that cannot set the `Idempotency-Key`
   * header. The header wins when both are present.
   *
   * Bounded and required non-empty: an empty string would be stored as
   * a real key and, being unique, would make the SECOND payment from
   * any other caller sending "" a replay of the first — which is worse
   * than having no idempotency at all.
   */
  idempotencyKey: z.string().min(8).max(255).optional(),
});

/**
 * Bulk-payment row. Either `loanId` (UUID) or `loanNumber` (LN-…) must
 * be present — the route handler resolves the human number to a UUID
 * before posting.
 */
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

export const bulkPaymentSchema = z.object({
  rows: z.array(bulkPaymentRowSchema).min(1).max(500),
  stopOnError: z.boolean().optional(),
});

/** Pre-termination settlement. */
export const closeEarlySchema = z.object({
  settlementAmount: z.number().positive(),
  reference: z.string().max(120).optional(),
});

/** Restructure: settle the original and create a replacement loan. */
export const restructureSchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive(),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
});

/**
 * Renewing a loan.
 *
 * Deliberately the same shape as a restructure — the paperwork of a new
 * loan is the same paperwork — but a different endpoint, because the
 * two mean opposite things about the borrower. Restructure rescues a
 * loan going wrong; renewal rewards one that went right.
 *
 * No `payoffAmount` field. The settlement figure is computed from the
 * old loan's schedule server-side and never accepted from the caller:
 * it decides how much cash leaves the till, and a client that could
 * name it could name the wrong one.
 */
export const renewSchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive(),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
});

/** Officer waiver of late-fee / penalty. */
export const waivePenaltySchema = z.object({
  waivedAmount: z.number().positive(),
  reason: z.string().min(3).max(500),
});

/** Write-off — reason is required for the audit trail. */
export const writeOffSchema = z.object({
  reason: z.string().min(1).max(500),
});

/**
 * Loan sign-off. Caller uploads to /uploads-api/signatures first, then
 * posts the resulting URL here. Optional `delegationId` lets a proxy
 * sign on behalf of an absent officer; the delegation must be active
 * and either blanket or explicitly include `loans.sign_officer`.
 */
export const signSchema = z.object({
  signatureUrl: z.string().min(1).max(500),
  delegationId: z.string().uuid().optional(),
});

/**
 * Co-maker intake — a REGISTERED CUSTOMER, not a typed-in name.
 *
 * The identity fields are gone. They used to be free text, which made a
 * jointly-liable party invisible to everything the system can do: no
 * KYC on file, no credit history, no way to see that the same person
 * was already guaranteeing four other loans. Name, phone, email and
 * address are now snapshotted from the Customer row on the server, so
 * they can't be typed to say something the record doesn't.
 *
 * What remains is what genuinely belongs to THIS guarantee rather than
 * to the person: their role on this loan, their relationship to this
 * borrower, and the paperwork.
 */
export const coMakerSchema = z.object({
  customerId: z.string().uuid({ message: "Choose a registered customer." }),
  role: z.enum(["CO_BORROWER", "GUARANTOR", "CO_MAKER"]).optional(),
  relationship: z.string().max(80).optional(),
  signedAgreementUrl: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Quote — preview schedule + fees for a candidate loan without
 * persisting. `productCode` selects the interest method + payment
 * frequency + fees; absent it defaults to declining-monthly no-fee.
 */
export const quoteSchema = z.object({
  principal: z.number().positive(),
  termMonths: z.number().int().positive(),
  annualInterestRate: z.number().min(0).max(1),
  productCode: z.string().optional(),
});

/**
 * Selfie-match — posted by the face-match worker after comparing the
 * apply-time selfie to the ID front. `score` is similarity in [0..1];
 * `distance` is the L2 embedding distance in [0..2]; `passed` reflects
 * the worker's threshold decision; `model` is the model identifier
 * (e.g. "face-api/ssd_mobilenetv1") for the audit trail.
 */
export const selfieMatchSchema = z.object({
  score: z.number().min(0).max(1),
  distance: z.number().min(0).max(2),
  passed: z.boolean(),
  model: z.string().min(1).max(80),
});

/**
 * Loan draft — apply-wizard saves progress between steps so the
 * officer can pause and resume. `formState` is owned by the wizard
 * and accepted as any JSON shape; final-submit validation runs
 * against `applySchema` separately.
 */
export const draftCreateSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  productCode: z.string().min(1).max(40).optional().nullable(),
  lastStep: z.number().int().min(0).max(20).optional(),
  formState: z.unknown(),
});

export const draftUpdateSchema = draftCreateSchema.partial();

export type SelfieMatchInput = z.infer<typeof selfieMatchSchema>;
export type DraftCreateInput = z.infer<typeof draftCreateSchema>;
export type DraftUpdateInput = z.infer<typeof draftUpdateSchema>;

/* ─── Spec-only request variants ────────────────────────────────────────
 *
 * `kycAnswers` / `answers` are records whose values may be NULL, and
 * `z.null()` inside a union renders (openApi3 target) as `nullable`
 * with no `type` — which AJV rejects at BOOT:
 * `Failed building the validation schema … "nullable" cannot be used
 * without "type"`. Found the hard way attaching `applySchema` verbatim.
 *
 * So the routes attach these variants, identical except the record
 * value is `z.unknown()` — strictly WIDER, so nothing the handler
 * accepts is refused at the door, and the controller's parse of the
 * real schema still enforces the union. The spec documents the value
 * loosely; the enforcement is unchanged.
 */

export const applyRequestSchema = applySchema.extend({
  kycAnswers: z.record(z.unknown()).optional(),
});

export const declarationAnswersRequestSchema = z.object({
  answers: z.record(z.unknown()),
});

/* ─── Request params, for the OpenAPI spec ──────────────────────────────
 *
 * Attaching these makes Fastify VALIDATE them, so they accept exactly
 * what the handlers accept. `:id` is deliberately NOT `.uuid()`:
 * `findByIdOrNumber` resolves the human "LN-2026-…" number too, and the
 * new frontend navigates by it — a uuid constraint would reject the
 * form the operator UI actually uses.
 */

export const loanIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * `:coMakerId` — also left loose. The co-maker lookups run findUnique
 * on the id column and answer 404/500 on a miss today; tightening to
 * `.uuid()` here would change which status a malformed id receives.
 */
export const coMakerIdParamSchema = z.object({
  coMakerId: z.string().min(1),
});

export const messageIdParamSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod rather than hand-written JSON Schema so they are real parsers — a
 * test can assert an actual payload against one. They declare what is
 * CONTRACTUAL, not everything a row carries; undeclared fields pass
 * through (see lib/openapi.ts). Two serialiser rules are load-bearing:
 *
 *   • A field declared without `.optional()` MUST be present on every
 *     payload the route can return — fast-json-stringify throws on a
 *     missing required property, turning a 200 into a 500.
 *   • Money columns are Prisma `Decimal` and reach the wire as STRINGS
 *     ("250000", "0.18"). Declaring them numeric would rewrite the wire
 *     format for every consumer. Figures computed in JS (`outstanding`,
 *     `payoffAmount`, quote maths) really are numbers and stay numbers.
 */

const loanStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "DISBURSED",
  "ACTIVE",
  "CLOSED",
  "DEFAULTED",
  "CANCELLED",
  "RESTRUCTURED",
  "WRITTEN_OFF",
]);

/**
 * A loan row on its own — what the write paths return. The columns
 * here exist on every LoanApplication row, so this shape is safe for
 * `create`/`update` results that carry no includes.
 */
export const loanResponseSchema = z.object({
  id: z.string().uuid(),
  /** "LN-2026-000123". Accepted in place of the id on every /loans/:id path. */
  number: z.string(),
  customerId: z.string().uuid(),
  productCode: z.string(),
  /** Decimal on the wire — e.g. "250000". */
  principal: z.string(),
  termMonths: z.number().int(),
  /** Decimal on the wire — "0.18" is 18%/year. */
  annualInterestRate: z.string(),
  purpose: z.string().nullable(),
  status: loanStatusSchema,
  decisionReason: z.string().nullable(),
  isRepeat: z.boolean(),
  /** 1-indexed position in the approval chain; null when no chain is live. */
  currentApprovalStep: z.number().int().nullable(),
  submittedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  submittedById: z.string().uuid(),
  decidedById: z.string().uuid().nullable(),
  disbursedById: z.string().uuid().nullable(),
});

/** Slim borrower projection carried on list rows and the detail. */
const loanCustomerRefSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});

/**
 * Where the loan stands, folded from its schedule in JS — real numbers,
 * not Decimals. Null before disbursement: no schedule exists yet, and a
 * zero balance on an approved loan would read as "nothing to pay".
 */
const loanBalanceSchema = z.object({
  scheduled: z.number(),
  paid: z.number(),
  outstanding: z.number(),
  principalScheduled: z.number(),
  principalPaid: z.number(),
  principalOutstanding: z.number(),
  paidInstallments: z.number().int(),
  totalInstallments: z.number().int(),
});

/** Offset-pagination envelope shared by the list endpoints. */
const pageOf = <T extends z.ZodType>(row: T) =>
  z.object({
    rows: z.array(row),
    /** Total matching the filter across all pages — not rows.length. */
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    /** At least 1 even when nothing matched. */
    totalPages: z.number().int(),
  });

export const loanListResponseSchema = pageOf(
  loanResponseSchema.extend({
    customer: loanCustomerRefSchema,
    balance: loanBalanceSchema.nullable(),
  }),
);

/** One schedule instalment. All money columns are Decimal strings. */
const scheduleRowResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  installmentNo: z.number().int(),
  dueDate: z.string().datetime(),
  principalDue: z.string(),
  interestDue: z.string(),
  totalDue: z.string(),
  principalPaid: z.string(),
  interestPaid: z.string(),
  paidInFullAt: z.string().datetime().nullable(),
});

export const loanPaymentResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  /** Decimal on the wire. */
  amount: z.string(),
  paidOn: z.string().datetime(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  /** Echoed back so a caller can recognise a replayed payment. */
  idempotencyKey: z.string().nullable(),
  recordedById: z.string().uuid(),
});

/** The GET /loans/:id read — row plus its schedule, payments and joins. */
export const loanDetailResponseSchema = loanResponseSchema.extend({
  schedule: z.array(scheduleRowResponseSchema),
  payments: z.array(loanPaymentResponseSchema),
  customer: loanCustomerRefSchema,
  product: z.object({ code: z.string(), name: z.string() }),
  vehicle: z.object({ id: z.string().uuid() }).nullable(),
  property: z.object({ id: z.string().uuid() }).nullable(),
  agent: z
    .object({
      id: z.string().uuid(),
      number: z.string(),
      user: z.object({ name: z.string() }),
    })
    .nullable(),
});

/** validateKyc rollup — GET /loans/:id/kyc-status. */
export const kycStatusResponseSchema = z.object({
  /** True only if every required doc is VERIFIED. */
  complete: z.boolean(),
  status: z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]),
  missing: z.array(z.string()),
  rejected: z.array(z.string()),
});

/** POST /loans/quote — pure calculator output; JS numbers throughout. */
export const quoteResponseSchema = z.object({
  monthlyPayment: z.number(),
  totalPaid: z.number(),
  totalInterest: z.number(),
  schedule: z.array(
    z.object({
      installmentNo: z.number().int(),
      principal: z.number(),
      interest: z.number(),
      payment: z.number(),
      balance: z.number(),
    }),
  ),
  fees: z.object({
    processing: z.number(),
    documentary: z.number(),
    total: z.number(),
    netDisbursement: z.number(),
  }),
  method: z.string(),
  frequency: z.string(),
  installments: z.number().int(),
});

/**
 * POST /loans/apply 201 — the created row plus the decisioning verdict.
 * `action` is never null: "no rule matched" is MANUAL_REVIEW, not
 * silence. `matched` carries the whole rule row and is left open.
 */
export const applyResponseSchema = loanResponseSchema.extend({
  decision: z.object({
    action: z.string(),
    reason: z.string(),
    matched: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
});

/** POST /loans/dry-run — preview of the same evaluation, nothing persisted. */
export const dryRunResponseSchema = z.object({
  verdict: z.enum(["APPROVE", "REVIEW", "REJECT"]),
  reason: z.string().nullable(),
  matchedRule: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Blocking conditions that are not decisioning rules. */
  gates: z.object({
    amlMatch: z.boolean(),
    kycComplete: z.boolean(),
    missingKycDocs: z.array(z.string()),
    rejectedKycDocs: z.array(z.string()),
  }),
  anomalies: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      message: z.string(),
      zScore: z.number().nullable(),
      observed: z.number().nullable(),
      baseline: z.number().nullable(),
    }),
  ),
  context: z.object({
    principal: z.number(),
    termMonths: z.number().int(),
    annualInterestRate: z.number(),
    productCode: z.string(),
    creditScore: z.number().nullable(),
    tier: z.string().nullable(),
    monthlyIncome: z.number(),
    existingActiveLoans: z.number().int(),
  }),
});

/** The declarations snapshot as stored — PUT /loans/:id/declarations. */
export const declarationsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      required: z.boolean(),
      /**
       * String / number / boolean, or null = not answered yet. Left as
       * `unknown` rather than the union: a nullable union renders as
       * `nullable` with no `type`, the exact shape that crashes boot
       * (see the spec-only request variants above).
       */
      answer: z.unknown(),
    }),
  ),
  answeredAt: z.string().datetime().nullable(),
  answeredById: z.string().nullable(),
});

/** A wizard draft. `formState` is owned by the wizard — any JSON shape. */
export const draftResponseSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  productCode: z.string().nullable(),
  lastStep: z.number().int(),
  formState: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const draftListResponseSchema = z.array(draftResponseSchema);

/**
 * GET /loans/:id/renewal-eligibility. `checkRenewal` returns a union —
 * flattened here because zod unions emit `anyOf`, which the permissive
 * serialiser pass cannot enter (see lib/openapi.ts). `eligible` is the
 * discriminant: true carries payoffAmount/paidFraction, false carries
 * reason/message.
 */
export const renewalEligibilityResponseSchema = z.object({
  loanNumber: z.string(),
  eligible: z.boolean(),
  /** What settling the old loan costs. Present when eligible. */
  payoffAmount: z.number().optional(),
  paidFraction: z.number().optional(),
  /** Machine-readable refusal. Present when not eligible. */
  reason: z.string().optional(),
  message: z.string().optional(),
});

/** POST /loans/:id/renew 201. Both money figures are computed numbers. */
export const renewResponseSchema = z.object({
  loan: loanResponseSchema,
  payoffAmount: z.number(),
  netProceeds: z.number(),
});

/** POST /loans/:id/restructure 201 — the settled original and its successor. */
export const restructureResponseSchema = z.object({
  original: loanResponseSchema,
  replacement: loanResponseSchema,
});

/** 207 body of POST /loans/payments/bulk — per-row outcomes. */
export const bulkPaymentResponseSchema = z.object({
  results: z.array(
    z.object({
      /** Index into the submitted rows, so failures map back to lines. */
      index: z.number().int(),
      loanNumber: z.string(),
      loanId: z.string().nullable(),
      ok: z.boolean(),
      paymentId: z.string().uuid().optional(),
      error: z.string().optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});

/** GET /loans/:id/penalties — accrued vs waived, computed numbers. */
export const penaltiesResponseSchema = z.object({
  originalPenalty: z.number(),
  waivedToDate: z.number(),
  outstanding: z.number(),
});

/** One historical waiver row — Decimal strings, plus who waived. */
export const penaltyWaiverListResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    loanId: z.string().uuid(),
    originalPenalty: z.string(),
    waivedAmount: z.string(),
    negotiatedPenalty: z.string(),
    reason: z.string(),
    journalEntryId: z.string().nullable(),
    waivedById: z.string().uuid(),
    waivedAt: z.string().datetime(),
    waivedBy: z.object({
      id: z.string().uuid(),
      name: z.string(),
      email: z.string(),
    }),
  }),
);

/**
 * POST /loans/:id/waive-penalty 201. The waiver figures here are
 * computed in JS at waive time — numbers, unlike the stored rows above.
 */
export const waivePenaltyResponseSchema = z.object({
  waiver: z.object({
    id: z.string().uuid(),
    originalPenalty: z.number(),
    negotiatedPenalty: z.number(),
  }),
  journalEntryId: z.string().uuid(),
});

/** POST /loans/:id/write-off 201. `amount` is what went to Bad Debt. */
export const writeOffResponseSchema = z.object({
  loan: loanResponseSchema,
  amount: z.number(),
});

/** POST /loans/:id/close-early — settlement breakdown. */
export const closeEarlyResponseSchema = z.object({
  loan: loanResponseSchema,
  payment: loanPaymentResponseSchema,
  remainingPrincipal: z.number(),
  fee: z.number(),
  totalSettled: z.number(),
});

/** A co-maker row. `inviteToken` is deliberately not declared. */
export const coMakerResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  /** Null only on rows that pre-date registered-customer co-makers. */
  customerId: z.string().uuid().nullable(),
  /** Snapshotted from the Customer row at add time. */
  fullName: z.string(),
  role: z.enum(["CO_BORROWER", "GUARANTOR", "CO_MAKER"]),
  relationship: z.string().nullable(),
  phone: z.string(),
  email: z.string().nullable(),
  status: z.enum(["PENDING", "APPROVED", "DECLINED"]),
  respondedAt: z.string().datetime().nullable(),
  declineReason: z.string().nullable(),
  inviteSentAt: z.string().datetime().nullable(),
  inviteExpiresAt: z.string().datetime().nullable(),
  linkOpenedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const coMakerListResponseSchema = z.array(
  coMakerResponseSchema.extend({
    documents: z.array(
      z.object({
        id: z.string().uuid(),
        documentType: z.string(),
        documentUrl: z.string(),
      }),
    ),
  }),
);

/**
 * POST /loans/co-makers/:coMakerId/invite. The URL comes back whether
 * or not delivery worked — `delivery` is the flattened InviteDelivery
 * union: sent=true carries channel/recipient, sent=false carries reason.
 */
export const coMakerInviteResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.string().datetime(),
  delivery: z.object({
    sent: z.boolean(),
    channel: z.string().optional(),
    recipient: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export const revokeInviteResponseSchema = z.object({
  ok: z.boolean(),
  /** False when there was no live link — still success: it doesn't work. */
  hadActiveLink: z.boolean(),
  coMaker: coMakerResponseSchema,
});

export const loanMessageResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  authorId: z.string().uuid(),
  /** Captured at send time; a later role change doesn't rewrite history. */
  authorRole: z.enum(["OFFICER", "BORROWER"]),
  body: z.string(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const loanMessageListResponseSchema = z.array(loanMessageResponseSchema);

/** One approval-chain row, labels frozen at submit. */
export const loanApprovalResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  stepOrder: z.number().int(),
  stepLabel: z.string(),
  requiredPermission: z.string(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "SKIPPED"]),
  notes: z.string().nullable(),
  approverId: z.string().uuid().nullable(),
  approvedAt: z.string().datetime().nullable(),
  /** Non-null when the approver acted as a stand-in under a Delegation. */
  signedUnderDelegationId: z.string().uuid().nullable(),
});

export const loanApprovalListResponseSchema = z.array(
  loanApprovalResponseSchema.extend({
    approver: z
      .object({ id: z.string().uuid(), name: z.string(), email: z.string() })
      .nullable(),
  }),
);

/** POST /loans/:id/approvals — `isFinal` means the loan just went APPROVED. */
export const approveStepResponseSchema = z.object({
  approval: loanApprovalResponseSchema,
  isFinal: z.boolean(),
  nextStep: z.number().int().nullable(),
});

// Inferred TypeScript types for service / test consumers.
export type ApplyInput = z.infer<typeof applySchema>;
export type DecideInput = z.infer<typeof decideSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;
export type CloseEarlyInput = z.infer<typeof closeEarlySchema>;
export type RestructureInput = z.infer<typeof restructureSchema>;
export type RenewInput = z.infer<typeof renewSchema>;
export type WaivePenaltyInput = z.infer<typeof waivePenaltySchema>;
export type WriteOffInput = z.infer<typeof writeOffSchema>;
export type SignInput = z.infer<typeof signSchema>;
export type CoMakerInput = z.infer<typeof coMakerSchema>;
export type QuoteInput = z.infer<typeof quoteSchema>;
