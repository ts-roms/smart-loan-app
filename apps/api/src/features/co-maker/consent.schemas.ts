import { z } from "zod";

/**
 * The co-maker's answer.
 *
 * A decline reason is required, not optional: a declined co-maker
 * blocks disbursement, and the officer's next move depends entirely on
 * why — "I never agreed to this" and "I want a smaller amount" lead
 * somewhere different.
 */
export const respondSchema = z
  .object({
    decision: z.enum(["APPROVED", "DECLINED"]),
    declineReason: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "DECLINED" && !v.declineReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declineReason"],
        message: "Tell us why you're declining.",
      });
    }
  });

export const documentSchema = z.object({
  documentType: z.enum([
    "ID_FRONT",
    "ID_BACK",
    "PROOF_OF_INCOME",
    "PROOF_OF_ADDRESS",
    "SELFIE",
    "VEHICLE_OR",
    "VEHICLE_CR",
    "PROPERTY_TITLE",
    "TAX_DECLARATION",
  ]),
  /** Produced by /uploads-api — see the routes file for why not a file. */
  documentUrl: z.string().min(1).max(500),
});

export type RespondInput = z.infer<typeof respondSchema>;
export type DocumentInput = z.infer<typeof documentSchema>;

/**
 * `:token` — the invite token, which IS the authorization on these
 * routes. Not a uuid: it is 32 random bytes plus the tenant slug (see
 * `parseInviteToken`), so it is described as a bounded opaque string.
 */
export const tokenParamSchema = z.object({ token: z.string().min(1).max(200) });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 *
 * These are the ONLY routes in this batch with no authentication at
 * all, and the response shapes reflect it: the consent view is a
 * deliberately NARROW projection of the loan, not the loan row. An
 * anonymous caller holding a valid token learns the loan number, the
 * principal, the term, the product name and the borrower's name —
 * everything a person needs to decide whether to take on joint
 * liability, and nothing more. Do not widen it to a `loanResponseSchema`
 * for consistency with the staff routes; the narrowness is the point.
 *
 * `principal` is a JS number here, not the usual Decimal string: the
 * handler folds it with `Number(loan.principal)` before sending.
 */

/**
 * GET /public/co-maker/:token — what the co-maker is being asked to
 * agree to.
 */
export const consentViewResponseSchema = z.object({
  coMakerId: z.string().uuid(),
  /** Snapshot taken when they were added, not a live customer read. */
  fullName: z.string(),
  role: z.enum(["CO_BORROWER", "GUARANTOR", "CO_MAKER"]),
  status: z.enum(["PENDING", "APPROVED", "DECLINED"]),
  respondedAt: z.string().datetime().nullable(),
  /**
   * The product's required KYC documents. A co-maker is underwritten
   * like a borrower because they carry the same liability, so this is
   * the borrower's requirement list verbatim.
   */
  requiredDocuments: z.array(z.string()),
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      coMakerId: z.string().uuid(),
      documentType: z.string(),
      documentUrl: z.string(),
      notes: z.string().nullable(),
      uploadedAt: z.string().datetime(),
    }),
  ),
  /** The narrow loan projection — see the note above. */
  loan: z.object({
    /** "LN-2026-000123". */
    number: z.string(),
    /** Folded with Number() by the handler — NOT a Decimal string. */
    principal: z.number(),
    termMonths: z.number().int(),
    productName: z.string(),
    borrowerName: z.string(),
  }),
  /** Who is asking. Falls back to the configured name when unset. */
  lender: z.object({ companyName: z.string() }),
});

/**
 * POST /public/co-maker/:token/respond — a bare acknowledgement.
 *
 * Deliberately says nothing about the loan or the decision: the
 * co-maker has just answered, and echoing state back to an anonymous
 * caller would widen what this token exposes for no benefit. Re-GET if
 * the page needs to re-render.
 */
export const respondResponseSchema = z.object({ ok: z.literal(true) });

/**
 * POST /public/co-maker/:token/upload — where the file landed.
 *
 * The URL is then passed back to /documents to record it. Two steps
 * rather than one because the upload goes through the same
 * `storeUpload` as the authenticated route — one allowlist and one size
 * cap, not two.
 */
export const uploadResponseSchema = z.object({ url: z.string() });

/** POST /public/co-maker/:token/documents — the recorded attachment. */
export const documentResponseSchema = z.object({
  id: z.string().uuid(),
  coMakerId: z.string().uuid(),
  documentType: z.string(),
  documentUrl: z.string(),
  notes: z.string().nullable(),
  uploadedAt: z.string().datetime(),
});
