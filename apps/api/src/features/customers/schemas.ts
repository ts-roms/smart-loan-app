import {
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  isValidPhone,
  normalizePhone,
} from "@loan/shared-utils";
import { z } from "zod";

/**
 * A PH phone number: 10 or 11 digits once punctuation and a country
 * code are stripped, stored normalised so "+63 917 123 4567" and
 * "09171234567" are one value rather than two.
 *
 * `transform` runs after the check, so what reaches the repository is
 * always digits — search and duplicate detection depend on that.
 */
/**
 * Normalises but does NOT reject.
 *
 * The length rule lives where the previous value is known: the create
 * refinement below, and the update service. A PATCH body carries every
 * field the form rendered, so rejecting here would let one bad legacy
 * number block every future edit of that record.
 */
const phoneField = () =>
  z
    .string()
    .max(40)
    .transform((v) => normalizePhone(v));

export const PHONE_MESSAGE = `Enter a phone number with ${PHONE_MIN_DIGITS} or ${PHONE_MAX_DIGITS} digits`;

/**
 * Customer registration schema — expanded for PH-standard borrower
 * onboarding. Includes conditional cross-field validation
 * driven by `.superRefine`:
 *
 *   • civilStatus === MARRIED   → spouseName is required
 *   • employmentStatus is one of EMPLOYED/SELF_EMPLOYED/FREELANCE
 *                                 → employerName + position required
 *
 * Most fields default to optional so partial saves still pass. The
 * client UI marks the required ones explicitly so the user knows
 * what's mandatory before submit.
 *
 * The base object schema is exported separately because `.partial()`
 * doesn't exist on ZodEffects (the result of `.superRefine`). PATCH
 * uses the base partial; POST uses the refined full schema.
 */
export const customerBaseSchema = z.object({
  // Personal
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  middleName: z.string().max(80).optional(),
  suffix: z.string().max(20).optional(),
  dateOfBirth: z.string(),
  gender: z
    .enum(["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY"])
    .optional(),
  sex: z.enum(["MALE", "FEMALE", "INTERSEX"]).optional(),
  civilStatus: z
    .enum(["SINGLE", "MARRIED", "WIDOWED", "SEPARATED", "ANNULLED", "DIVORCED"])
    .optional(),

  // Contact — email is required for statement-of-account delivery,
  // notification dispatch, and portal account provisioning. Operators
  // can still leave it blank temporarily by holding the form in draft;
  // the API enforces it on commit.
  phone: phoneField(),
  secondaryPhone: phoneField().optional(),
  email: z.string().email(),

  // Address (PSGC-style)
  address: z.string().max(500),
  addressLine2: z.string().max(500).optional(),
  barangay: z.string().max(120).optional(),
  city: z.string().max(80),
  province: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  postalCode: z.string().max(20).optional(),

  // Spouse (validated below)
  spouseName: z.string().max(160).optional(),
  spouseDateOfBirth: z.string().optional(),
  spouseContact: phoneField().optional(),
  spouseOccupation: z.string().max(120).optional(),

  // Government ID
  governmentIdType: z.enum([
    "PASSPORT",
    "DRIVERS_LICENSE",
    "NATIONAL_ID",
    "SSS",
    "TIN",
    "OTHER",
  ]),
  governmentIdNumber: z.string().max(60),

  // Employment
  employmentStatus: z.enum([
    "EMPLOYED",
    "SELF_EMPLOYED",
    "FREELANCE",
    "UNEMPLOYED",
    "RETIRED",
    "STUDENT",
  ]),
  employerName: z.string().max(200).optional(),
  jobTitle: z.string().max(120).optional(),
  position: z.string().max(120).optional(),
  hireDate: z.string().optional(),
  regularizationDate: z.string().optional(),
  monthlyIncome: z.number().nonnegative(),
  yearsAtCurrentJob: z.number().nonnegative().optional(),
});

/**
 * Cross-field validation applied on full POST payloads. PATCH paths
 * skip this because partial updates can legitimately set just one
 * field — re-checking the conditional rule there would force the UI
 * to resend unchanged spouse fields on every status edit.
 */
export const customerSchema = customerBaseSchema.superRefine((data, ctx) => {
  // A new record has no number on file to preserve, so the rule
  // applies outright here. Updates go through the service, which
  // compares against what's stored — see phoneChangeError.
  for (const field of ["phone", "secondaryPhone", "spouseContact"] as const) {
    const value = data[field];
    if (value === undefined) continue;
    if (field !== "phone" && value.trim() === "") continue;
    if (!isValidPhone(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: PHONE_MESSAGE,
      });
    }
  }

  if (data.civilStatus === "MARRIED" && !data.spouseName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["spouseName"],
      message: "Spouse name is required when civil status is MARRIED.",
    });
  }
  const needsEmployer =
    data.employmentStatus === "EMPLOYED" ||
    data.employmentStatus === "SELF_EMPLOYED" ||
    data.employmentStatus === "FREELANCE";
  if (needsEmployer && !data.employerName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["employerName"],
      message:
        "Company / employer name is required for this employment status.",
    });
  }
});

/** Output type after `customerSchema` parses successfully. */
export type CustomerWriteInput = z.infer<typeof customerSchema>;

/** Partial of the base — what PATCH bodies look like on the wire. */
export type CustomerPatchInput = z.infer<
  ReturnType<typeof customerBaseSchema.partial>
>;

/**
 * Bulk import wire schema — a thin envelope around an array of customer
 * rows. We deliberately use `passthrough` per row so the per-row zod
 * refinement inside the service can give a precise field-level error;
 * if we refined here, all rows would be lumped into one validation
 * failure and the operator couldn't tell which line was bad.
 */
export const bulkImportSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(500),
  stopOnError: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

export type BulkImportInput = z.infer<typeof bulkImportSchema>;

/**
 * Query-string for GET /customers. Every field optional — the bare
 * endpoint keeps returning the 200 most recent, which is what the
 * pickers around the app expect.
 *
 * `page` and `pageSize` are coerced because query strings are always
 * text, and are left loosely bounded here because the repository clamps
 * them anyway: a stale `?page=0` bookmark should land on page 1, not on
 * a 400.
 */
export const customerListQuerySchema = z.object({
  q: z.string().max(120).optional(),
  kycStatus: z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]).optional(),
  /**
   * Query strings carry no booleans, so accept the string form the
   * browser actually sends. Absent means false: excluding archived
   * customers is the safe default, and every picker in the app relies
   * on getting it without asking.
   */
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

/** Ledger query-string for /:id/ledger and /:id/ledger.pdf. */
export interface LedgerQuery {
  from?: string;
  to?: string;
  scope?: string;
  format?: string;
}

/** Narrowed ledger scope after route-level validation. */
export type LedgerScope = "ALL" | "LOANS" | "COOP";

/**
 * Archive / restore. The reason is optional — an operator tidying the
 * register at 5pm shouldn't stall on a text field — but it is what
 * makes the audit row answer "why is this member filed away" later.
 */
export const archiveCustomerSchema = z.object({
  archived: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export type ArchiveCustomerInput = z.infer<typeof archiveCustomerSchema>;

/* ─── Request params, for the OpenAPI spec ──────────────────────────────
 *
 * `:id` accepts the UUID or the human "CUST-2026-…" number, which is
 * what the frontend navigates by — so deliberately not `.uuid()`.
 */
export const customerIdParamSchema = z.object({
  id: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against. They
 * name what is CONTRACTUAL; undeclared columns pass through (see
 * lib/openapi.ts). House rules that are load-bearing here:
 *
 *   • Undeclared-optional beats wrongly-required: fast-json-stringify
 *     throws on a missing required property.
 *   • `monthlyIncome` is NUMERIC(14,2); Prisma's Decimal serialises as
 *     a STRING. So do the loan money columns on the summary rows.
 */

const kycStatusEnum = z.enum(["NONE", "PENDING", "VERIFIED", "REJECTED"]);

export const customerResponseSchema = z.object({
  id: z.string().uuid(),
  /** "CUST-2026-000123". Accepted in place of the id on /customers/:id. */
  number: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  dateOfBirth: z.string().datetime(),
  phone: z.string(),
  secondaryPhone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  governmentIdType: z.string(),
  governmentIdNumber: z.string(),
  employmentStatus: z.string(),
  /** Decimal on the wire — e.g. "45000". */
  monthlyIncome: z.string(),
  kycStatus: kycStatusEnum,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Non-null = PII overwritten under a data-privacy request. */
  erasedAt: z.string().datetime().nullable(),
  /** Non-null = filed away (soft delete); hidden from pickers. */
  archivedAt: z.string().datetime().nullable(),
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

export const customerListResponseSchema = pageOf(
  customerResponseSchema.extend({
    /** A loan currently APPROVED / DISBURSED / ACTIVE exists. */
    hasLoans: z.boolean(),
    /** Ever DEFAULTED or WRITTEN_OFF. */
    hasDefaulted: z.boolean(),
  }),
);

export const customerSummaryResponseSchema = z.object({
  customer: customerResponseSchema,
  activeLoansCount: z.number().int(),
  totalLoansCount: z.number().int(),
  /** Folded in JS — a real number. */
  outstanding: z.number(),
  activeLoans: z.array(
    z.object({
      id: z.string().uuid(),
      number: z.string(),
      productCode: z.string(),
      /** Straight off the row — a Decimal string. */
      principal: z.string(),
      status: z.string(),
      disbursedAt: z.string().datetime().nullable(),
    }),
  ),
});

/**
 * Consolidated exposure. Every figure is computed in JS from the
 * schedules — numbers, not Decimal strings.
 */
export const customerExposureResponseSchema = z.object({
  customerId: z.string().uuid(),
  customerNumber: z.string(),
  /** The instant arrears were measured against. */
  asOf: z.string().datetime(),
  /** Every loan, counted or not — `counted` says which. */
  loans: z.array(
    z.object({
      loanId: z.string().uuid(),
      loanNumber: z.string(),
      productCode: z.string(),
      productName: z.string().nullable(),
      status: z.string(),
      principal: z.number(),
      principalOutstanding: z.number(),
      outstanding: z.number(),
      pastDue: z.number(),
      overdueInstallments: z.number().int(),
      /** Whether this row's figures are inside `total`. */
      counted: z.boolean(),
      /** False = no schedule yet; contracted principal stands in. */
      fromSchedule: z.boolean(),
      /** What went to Bad Debt on a WRITTEN_OFF row. Zero elsewhere. */
      writtenOff: z.number(),
    }),
  ),
  total: z.object({
    principalOutstanding: z.number(),
    outstanding: z.number(),
    pastDue: z.number(),
    activeLoans: z.number().int(),
  }),
  /** Loans deliberately outside `total`, reported rather than dropped. */
  excluded: z.object({
    loans: z.number().int(),
    closedLoans: z.number().int(),
    writtenOffLoans: z.number().int(),
    writtenOffPrincipal: z.number(),
  }),
});

export const repeatEligibilityResponseSchema = z.object({
  customerId: z.string().uuid(),
  /** ≥1 CLOSED loan, no DEFAULTED / WRITTEN_OFF in history. */
  eligible: z.boolean(),
  closedLoansCount: z.number().int(),
  defaultedLoansCount: z.number().int(),
  writtenOffLoansCount: z.number().int(),
  lastClosedAt: z.string().datetime().nullable(),
  kycVerified: z.boolean(),
});

/** PATCH /customers/:id/archive — idempotent either direction. */
export const archiveCustomerResponseSchema = z.object({
  ok: z.boolean(),
  customerId: z.string().uuid(),
  number: z.string(),
  /** Null after a restore. */
  archivedAt: z.string().datetime().nullable(),
});

/** 207 body of POST /customers/bulk — per-row outcomes in CSV order. */
export const bulkImportResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      ok: z.boolean(),
      id: z.string().uuid().optional(),
      number: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
  /** True when nothing was persisted — validation preview only. */
  dryRun: z.boolean(),
});

/**
 * The unified statement of account — GET /customers/:id/ledger without
 * `?format=csv`. All money figures are folded in JS: numbers.
 */
export const customerLedgerResponseSchema = z.object({
  customer: z.object({
    id: z.string().uuid(),
    number: z.string(),
    firstName: z.string(),
    middleName: z.string().nullable(),
    lastName: z.string(),
    email: z.string().nullable(),
    phone: z.string(),
  }),
  asOf: z.string().datetime(),
  /** Echoes the caller's bounds; null = unbounded. */
  range: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  scope: z.enum(["ALL", "LOANS", "COOP"]),
  summary: z.object({
    totalDisbursed: z.number(),
    totalRepaid: z.number(),
    totalPenaltyWaived: z.number(),
    outstandingPrincipal: z.number(),
    savingsBalance: z.number(),
    savingsDeposits: z.number(),
    savingsWithdrawals: z.number(),
    contributionsTotal: z.number(),
    capitalBuildUp: z.number(),
    mortuaryFund: z.number(),
    emergencyFund: z.number(),
    /** What the member owes right now. */
    amountOwed: z.number(),
    /** What the coop holds for them. NEVER add it to amountOwed. */
    amountHeld: z.number(),
  }),
  /** Newest first — the FIRST row carries the current position. */
  entries: z.array(
    z.object({
      date: z.string(),
      kind: z.string(),
      description: z.string(),
      /** Always positive — `direction` says which way it goes. */
      amount: z.number(),
      direction: z.enum(["INFLOW", "OUTFLOW"]),
      loanNumber: z.string().nullable(),
      owedAfter: z.number(),
      heldAfter: z.number(),
    }),
  ),
});

/** 202 of POST /customers/:id/ledger/email. */
export const statementEmailResponseSchema = z.object({
  ok: z.boolean(),
  /** Null when the customer has no email — in-app notification only. */
  sentTo: z.string().nullable(),
  message: z.string(),
});
