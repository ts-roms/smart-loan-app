import { z } from "zod";

/**
 * Wire schema for POST /kyc — submit a document for verification.
 *
 * The documentType enum is hand-mirrored from Prisma's KycDocumentType.
 * Keep this list in sync with libs/db/prisma/schema.prisma — zod can't
 * introspect Prisma types.
 */
export const submitSchema = z.object({
  customerId: z.string().uuid(),
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
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

export type SubmitKycInput = z.infer<typeof submitSchema>;

/**
 * Wire schema for POST /kyc/:id/decide — officer flips a submission
 * to VERIFIED / REJECTED with an optional reason for the audit trail.
 */
export const decisionSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().max(500).optional(),
});

export type DecideKycInput = z.infer<typeof decisionSchema>;

/* ─── Request params + query, for the OpenAPI spec ──────────────────────
 *
 * Attaching these makes Fastify VALIDATE them — there is no
 * documentation-only slot — so they are written to accept exactly what
 * the handlers accept today and nothing narrower.
 */

/** The document-type enum, shared by the request and response shapes. */
const documentTypeEnum = z.enum([
  "ID_FRONT",
  "ID_BACK",
  "PROOF_OF_INCOME",
  "PROOF_OF_ADDRESS",
  "SELFIE",
  "VEHICLE_OR",
  "VEHICLE_CR",
  "PROPERTY_TITLE",
  "TAX_DECLARATION",
]);

/**
 * `?customerId=` on `GET /kyc`.
 *
 * Optional here even though the handler REQUIRES it. The controller
 * answers its own 400 (`{ error: "BadRequest", message: "customerId
 * required" }`) when it is absent, and making it required in the schema
 * would move that rejection into Fastify and change the body callers
 * already receive. Documented as optional, described as mandatory.
 */
export const kycListQuerySchema = z.object({
  /** Required in practice — omitting it is a 400 from the handler. */
  customerId: z.string().uuid().optional(),
});

/** Paging for the review queue. Both coerced — they arrive as strings. */
export const kycPendingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/** `:id` on the decide route. */
export const kycIdParamSchema = z.object({ id: z.string().uuid() });

/** `:customerId` on the status rollup. */
export const kycCustomerIdParamSchema = z.object({
  customerId: z.string().uuid(),
});

/* ─── Responses ────────────────────────────────────────────────────────*/

/**
 * One KYC submission, as stored.
 *
 * The repository returns the Prisma row untouched — no `select`, no
 * relation include — so this is the model's own scalar list. `notes`,
 * `reason`, `decidedAt` and `decidedById` are null until somebody
 * decides the submission.
 */
export const kycSubmissionResponseSchema = z.object({
  id: z.string().uuid(),
  /** Human-readable, e.g. "KYC-2026-000123". */
  number: z.string(),
  customerId: z.string().uuid(),
  documentType: documentTypeEnum,
  /** `/uploads/kyc/<uuid>.jpg` — fetch it through `POST /uploads-api/sign`. */
  documentUrl: z.string(),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED"]),
  notes: z.string().nullable(),
  /** Why it was rejected, when it was. */
  reason: z.string().nullable(),
  submittedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  submittedById: z.string().uuid(),
  decidedById: z.string().uuid().nullable(),
});

/** `GET /kyc` — every submission for one customer. A bare array. */
export const kycListResponseSchema = z.array(kycSubmissionResponseSchema);

/**
 * `GET /kyc/pending` — the review queue, oldest first.
 *
 * A flattened projection rather than the stored row: the repository
 * joins the customer and folds first/last name into one `customerName`
 * so the queue renders without a second fetch per row.
 */
export const kycPendingResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().uuid(),
      number: z.string(),
      customerId: z.string().uuid(),
      customerNumber: z.string(),
      /** "First Last", joined by the repository. */
      customerName: z.string(),
      customerPhone: z.string(),
      documentType: documentTypeEnum,
      documentUrl: z.string(),
      status: z.enum(["PENDING", "VERIFIED", "REJECTED"]),
      submittedAt: z.string().datetime(),
    }),
  ),
  /** Total matching the filter across all pages — not rows.length. */
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** At least 1 even when nothing matched. */
  totalPages: z.number().int(),
});

/**
 * `GET /kyc/customers/:customerId/status` — the rollup the UI shows as
 * "needs X / Y / Z".
 *
 * Computed by `validateKyc`, not stored: `complete` is true only when
 * every required document is VERIFIED. `missing` and `rejected` are
 * always arrays, empty rather than absent, so a caller can render them
 * without a null check.
 */
export const kycStatusResponseSchema = z.object({
  complete: z.boolean(),
  /** Mirrors `Customer.kycStatus`. NONE = nothing submitted at all. */
  status: z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]),
  missing: z.array(documentTypeEnum),
  rejected: z.array(documentTypeEnum),
});
