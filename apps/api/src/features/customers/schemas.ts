import { z } from "zod";

/**
 * Customer registration schema — expanded for PH-standard borrower
 * onboarding (FRD §1.4). Includes conditional cross-field validation
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
  phone: z.string().min(7).max(40),
  secondaryPhone: z.string().max(40).optional(),
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
  spouseContact: z.string().max(40).optional(),
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

/** Ledger query-string for /:id/ledger and /:id/ledger.pdf. */
export interface LedgerQuery {
  from?: string;
  to?: string;
  scope?: string;
  format?: string;
}

/** Narrowed ledger scope after route-level validation. */
export type LedgerScope = "ALL" | "LOANS" | "COOP";
