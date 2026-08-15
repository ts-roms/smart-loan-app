// Licensing
/**
 * License lifecycle status the API returns from GET /license/status.
 *
 *   - ACTIVE     — current license verifies; the app is fully unlocked
 *                  according to its feature list.
 *   - EXPIRED    — there's a license row but its `exp` has passed. The
 *                  UI nudges to renew; premium endpoints return 402.
 *   - TAMPERED   — there's a license row but its signature no longer
 *                  verifies (post-key-rotation, or someone edited the
 *                  row by hand). Re-paste a fresh token to fix.
 *   - NONE       — no license has been activated yet. Premium endpoints
 *                  return 402; core endpoints still work.
 *   - NO_KEY     — LICENSE_PUBLIC_KEY_* isn't configured on this deploy.
 *                  Operator action required (set env, restart).
 */
export type LicenseStatusKind =
  "ACTIVE" | "EXPIRED" | "TAMPERED" | "NONE" | "NO_KEY";

export type LicenseTier = "BASIC" | "PROFESSIONAL" | "ENTERPRISE";

/**
 * Feature flag keys are stable across releases — the resolver, the
 * 402 response, and the catalog UI all read from the same string set.
 * See libs/licensing/src/types.ts for the canonical list.
 */
export type LicenseFeatureFlag =
  | "core.customers"
  | "core.loans"
  | "core.kyc"
  | "core.scoring"
  | "servicing.collections"
  | "servicing.demand_letters"
  | "servicing.repossession"
  | "servicing.lease"
  | "accounting.gl"
  | "accounting.periods"
  | "accounting.ecl"
  | "accounting.reconciliation"
  | "cooperative.contributions"
  | "cooperative.savings"
  | "cooperative.funds"
  | "compliance.dorsi"
  | "compliance.annual_docs"
  | "compliance.reports"
  | "intel.ai_assistant"
  | "intel.id_ocr"
  | "intel.face_match"
  | "intel.anomaly_flags"
  | "bulk.customers"
  | "bulk.users"
  | "bulk.payments";

export interface LicenseStatusPayload {
  status: LicenseStatusKind;
  tenant?: string;
  tier?: LicenseTier;
  features?: LicenseFeatureFlag[];
  seats?: number;
  issuedAt?: string;
  notBefore?: string;
  expiresAt?: string;
  notes?: string;
  /** Days remaining until expiry. Negative when already past. */
  daysUntilExpiry?: number;
  /** Human-readable reason when status !== ACTIVE. */
  message?: string;
}

/**
 * 402 Payment Required body shape. The api-client treats this status
 * code as a "feature locked" condition and surfaces the `kind` so the
 * UI can route to the right hint (configure key vs. renew vs. upgrade).
 */
export interface FeatureLockedError {
  error: "FeatureLocked";
  kind:
    | "NoneActive"
    | "Expired"
    | "Tampered"
    | "NoKeyConfigured"
    | "FeatureMissing";
  message: string;
  requiredFeatures: LicenseFeatureFlag[];
  /** Present only when kind === FeatureMissing — the current tier. */
  tier?: LicenseTier;
}

// User + auth
/**
 * Canonical user roles. The string union is the single source of truth —
 * components needing the set of roles should import `USER_ROLES` rather
 * than re-typing the literals. Used by RBAC gates, nav role filters, etc.
 */
export const USER_ROLES = [
  "ADMIN",
  "LOAN_OFFICER",
  "ACCOUNTANT",
  "COLLECTOR",
  "AGENT",
  "CUSTOMER",
] as const;
export type UserRole = (typeof USER_ROLES)[number];
/**
 * Staff (non-customer) — the console personas combined.
 *
 * AGENT is staff and belongs here: agents sign into the console, not
 * the borrower portal. They see one page, because their role grants one
 * permission — the shell renders from permissions, not from this list.
 */
export const STAFF_ROLES = [
  "ADMIN",
  "LOAN_OFFICER",
  "ACCOUNTANT",
  "COLLECTOR",
  "AGENT",
] as const satisfies ReadonlyArray<UserRole>;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Customer
export type GovernmentIdType =
  "PASSPORT" | "DRIVERS_LICENSE" | "NATIONAL_ID" | "SSS" | "TIN" | "OTHER";
export type EmploymentStatus =
  | "EMPLOYED"
  | "SELF_EMPLOYED"
  | "FREELANCE"
  | "UNEMPLOYED"
  | "RETIRED"
  | "STUDENT";
export type Gender = "MALE" | "FEMALE" | "NON_BINARY" | "PREFER_NOT_TO_SAY";
export type Sex = "MALE" | "FEMALE" | "INTERSEX";
export type CivilStatus =
  "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED" | "DIVORCED";
export type KycStatus = "NONE" | "PENDING" | "VERIFIED" | "REJECTED";

export interface Customer {
  id: string;
  /**
   * Human-readable reference number ("CUST-2026-000123"). Used in URLs
   * and operator-facing UI in place of the UUID — see the bigger
   * "reference numbers" pass for the broader migration. The UUID stays
   * authoritative for FK joins inside payloads.
   */
  number: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** Generational suffix (Jr / Sr / III). Null when not applicable. */
  suffix: string | null;
  dateOfBirth: string;
  gender: Gender | null;
  sex: Sex | null;
  civilStatus: CivilStatus | null;

  /** Primary mobile. DB column is still `phone` for back-compat. */
  phone: string;
  secondaryPhone: string | null;
  email: string | null;

  /** Free-form street + house/unit. DB column is `address`. */
  address: string;
  addressLine2: string | null;
  barangay: string | null;
  city: string;
  province: string | null;
  region: string | null;
  postalCode: string | null;

  // Spouse — populated only when civilStatus === 'MARRIED'.
  spouseName: string | null;
  spouseDateOfBirth: string | null;
  spouseContact: string | null;
  spouseOccupation: string | null;

  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;

  employmentStatus: EmploymentStatus;
  employerName: string | null;
  jobTitle: string | null;
  position: string | null;
  hireDate: string | null;
  regularizationDate: string | null;
  monthlyIncome: string | number;
  yearsAtCurrentJob: string | number | null;

  kycStatus: KycStatus;
  /**
   * Set when the customer's PII was redacted under a Data Privacy Act
   * erasure request. The identifying fields then hold "[ERASED]"
   * placeholders — the UI shows a badge so blank-looking records read
   * as "erased on purpose", not "data loss".
   */
  erasedAt: string | null;
  /**
   * Soft delete. Set when the customer was filed away: they drop out of
   * pickers and the default list and cannot take a new loan, while
   * every loan, payment and ledger line that references them stays put.
   * Null once restored.
   */
  archivedAt: string | null;
  archiveReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What `GET /customers` returns: the customer record plus two cheap risk
 * markers, used by the New Loan borrower picker to rank and to warn.
 *
 * Only the list endpoint computes them. `GET /customers/:id` stays a
 * plain {@link Customer} — hence the separate type rather than optional
 * fields that every consumer would have to null-check.
 *
 * Neither flag replaces `/customers/:id/repeat-eligibility`, which is
 * the authoritative read on repeat-borrower standing (closed-loan count,
 * fast-path eligibility, decline reasons).
 */
export interface CustomerListItem extends Customer {
  /**
   * A loan is live right now: APPROVED, DISBURSED, or ACTIVE. Current
   * exposure, not history — closed, defaulted, rejected, cancelled, and
   * still-in-review applications all leave this false.
   */
  hasLoans: boolean;
  /**
   * A loan has gone bad at some point: DEFAULTED or WRITTEN_OFF. Never
   * clears — a subsequent good loan sets `hasLoans` without unsetting
   * this. RESTRUCTURED doesn't count (workout, not a loss).
   */
  hasDefaulted: boolean;
}

export interface CustomerCreateInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  suffix?: string;
  dateOfBirth: string;
  gender?: Gender;
  sex?: Sex;
  civilStatus?: CivilStatus;

  phone: string;
  secondaryPhone?: string;
  email?: string;

  address: string;
  addressLine2?: string;
  barangay?: string;
  city: string;
  province?: string;
  region?: string;
  postalCode?: string;

  spouseName?: string;
  spouseDateOfBirth?: string;
  spouseContact?: string;
  spouseOccupation?: string;

  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;

  employmentStatus: EmploymentStatus;
  employerName?: string;
  jobTitle?: string;
  position?: string;
  hireDate?: string;
  regularizationDate?: string;
  monthlyIncome: number;
  yearsAtCurrentJob?: number;
}

// KYC
export type KycDocumentType =
  | "ID_FRONT"
  | "ID_BACK"
  | "PROOF_OF_INCOME"
  | "PROOF_OF_ADDRESS"
  | "SELFIE"
  | "VEHICLE_OR"
  | "VEHICLE_CR"
  | "PROPERTY_TITLE"
  | "TAX_DECLARATION";
export type KycSubmissionStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface KycSubmission {
  id: string;
  /** Human-readable reference number ("KYC-2026-000123"). */
  number: string;
  customerId: string;
  documentType: KycDocumentType;
  documentUrl: string;
  status: KycSubmissionStatus;
  notes: string | null;
  reason: string | null;
  submittedAt: string;
  decidedAt: string | null;
}

export interface KycValidationResult {
  complete: boolean;
  status: KycStatus;
  missing: KycDocumentType[];
  rejected: KycDocumentType[];
}

// Scoring
export type CreditTier = "A" | "B" | "C" | "D" | "F";

export interface FactorBreakdown {
  factorId: string;
  label: string;
  maxPoints: number;
  weight: number;
  points: number;
  source: string;
}

export interface CreditScoreResult {
  score: number;
  tier: CreditTier;
  rawScore: number;
  maxRaw: number;
  breakdown: FactorBreakdown[];
}

export interface CreditScore {
  id: string;
  customerId: string;
  score: number;
  tier: CreditTier;
  breakdown: FactorBreakdown[];
  sourceSurveyId: string | null;
  /**
   * Which scorecard revision produced this score.
   *
   * Null on scores computed before the catalog was versioned. That is a
   * fact about the record, not a gap to paper over with the current
   * version — the scorecard of the day was never written down, and a UI
   * that filled it in would be inventing the audit trail it claims to
   * show.
   */
  catalogVersion: number | null;
  computedAt: string;
}

export type SurveyAnswer = string | number | boolean;

export type SurveyQuestion =
  | {
      kind: "choice";
      id: string;
      label: string;
      help?: string;
      options: Array<{ label: string; value: string; weight: number }>;
      factorId: string;
    }
  | {
      kind: "number";
      id: string;
      label: string;
      help?: string;
      min: number;
      max: number;
      step?: number;
      factorId: string;
      inverted?: boolean;
    }
  | {
      kind: "boolean";
      id: string;
      label: string;
      help?: string;
      weightWhenTrue: number;
      factorId: string;
    };

// Loans
export type LoanStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "DISBURSED"
  | "ACTIVE"
  | "CLOSED"
  | "DEFAULTED"
  | "CANCELLED"
  // Both exist in the Prisma enum and are reachable through
  // /loans/:id/restructure and /loans/:id/write-off; they were missing
  // here, so any client narrowing on this type couldn't name a loan it
  // would still be served.
  | "RESTRUCTURED"
  | "WRITTEN_OFF";

/**
 * Product types are a string code now — the catalog is dynamic and admins
 * can add new products at runtime. The classic four still ship as defaults.
 */
export type LoanType = string;
export type CollateralKind = "NONE" | "VEHICLE" | "PROPERTY";
export type CollateralStatus = "PROPOSED" | "VERIFIED" | "RELEASED" | "SEIZED";
export type InterestMethod = "DECLINING" | "FLAT";
export type PaymentFrequency = "MONTHLY" | "BIWEEKLY" | "WEEKLY";

/**
 * ─── Per-product KYC declarations ─────────────────────────────────
 * Wire mirror of @loan/kyc's declaration types (shared-types stays
 * dependency-free by convention — same as KycDocumentType).
 */
export type KycQuestionType = "TEXT" | "YES_NO" | "NUMBER" | "SELECT";

export interface KycQuestion {
  id: string;
  label: string;
  type: KycQuestionType;
  options?: string[];
  required: boolean;
  hint?: string;
  /** Free-text grouping heading; blank groups under "General". */
  category?: string;
}

export interface KycDeclarationItem {
  id: string;
  label: string;
  type: KycQuestionType;
  options?: string[];
  required: boolean;
  category?: string;
  answer: string | number | boolean | null;
}

/** LoanApplication.kycDeclarations — questions + answers as attested. */
export interface KycDeclarations {
  items: KycDeclarationItem[];
  answeredAt: string | null;
  answeredById: string | null;
}

/** Raw answers on the wire: question id → value. */
export type KycAnswers = Record<string, string | number | boolean | null>;

export interface LoanProduct {
  id: string;
  code: string;
  name: string;
  description: string | null;
  collateralKind: CollateralKind;
  requiredKycDocs: KycDocumentType[];
  /** Admin-built declaration questionnaire; null/empty = none. */
  kycQuestions?: KycQuestion[] | null;

  minPrincipal: string | number;
  maxPrincipal: string | number;
  minTermMonths: number;
  maxTermMonths: number;
  defaultRate: string | number;
  minRate: string | number;
  maxRate: string | number;
  maxLoanToValue: string | number | null;

  processingFeeRate: string | number;
  processingFeeFlat: string | number;
  documentaryStampRate: string | number;
  lateFeeDailyRate: string | number;
  lateFeeCapFraction: string | number;
  lateFeeGraceDays: number;
  preTerminationFeeRate: string | number;

  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;

  rateByTier: Partial<Record<CreditTier, number | null>> | null;
  ltvByTier: Partial<Record<CreditTier, number>> | null;

  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoanProductCreateInput {
  code: string;
  name: string;
  description?: string;
  collateralKind?: CollateralKind;
  requiredKycDocs?: KycDocumentType[];
  kycQuestions?: KycQuestion[] | null;
  minPrincipal: number;
  maxPrincipal: number;
  minTermMonths: number;
  maxTermMonths: number;
  defaultRate: number;
  minRate: number;
  maxRate: number;
  maxLoanToValue?: number | null;
  processingFeeRate?: number;
  processingFeeFlat?: number;
  documentaryStampRate?: number;
  lateFeeDailyRate?: number;
  lateFeeCapFraction?: number;
  lateFeeGraceDays?: number;
  preTerminationFeeRate?: number;
  interestMethod?: InterestMethod;
  paymentFrequency?: PaymentFrequency;
  rateByTier?: Partial<Record<CreditTier, number | null>> | null;
  ltvByTier?: Partial<Record<CreditTier, number>> | null;
  active?: boolean;
}

export type LoanProductUpdateInput = Partial<
  Omit<LoanProductCreateInput, "code">
>;

export interface VehicleInput {
  kind: "CAR" | "MOTORCYCLE";
  make: string;
  model: string;
  year: number;
  plateNumber?: string;
  chassisNumber?: string;
  engineNumber?: string;
  color?: string;
  appraisedValue: number;
  notes?: string;
}

export interface Vehicle extends Omit<VehicleInput, "appraisedValue"> {
  id: string;
  /** Human-readable reference number ("VEH-000123"). */
  number: string;
  appraisedValue: string | number;
  status: CollateralStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyInput {
  propertyType: string;
  address: string;
  city: string;
  province?: string;
  postalCode?: string;
  titleNumber?: string;
  taxDecNumber?: string;
  areaSqm?: number;
  appraisedValue: number;
  notes?: string;
}

export interface Property extends Omit<
  PropertyInput,
  "appraisedValue" | "areaSqm"
> {
  id: string;
  /** Human-readable reference number ("PROP-000123"). */
  number: string;
  areaSqm: string | number | null;
  appraisedValue: string | number;
  status: CollateralStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Borrower projection carried on loan list rows. Four columns rather than
 * the whole customer: the list needs a name to show and to search on, and
 * has no business shipping every borrower's income and government ID to a
 * screen that displays neither.
 */
export interface LoanListCustomer {
  id: string;
  number: string;
  firstName: string;
  lastName: string;
}

/**
 * Where a loan actually stands, folded from its persisted schedule.
 *
 * Computed server-side by @loan/loans so the borrower's dashboard, the
 * amortization panel and the statement PDF can't quote three different
 * balances for the same loan.
 */
export interface LoanBalanceSummary {
  /** Contractual total across every instalment: principal + interest. */
  scheduled: number;
  /** Everything credited so far, principal and interest together. */
  paid: number;
  /** `scheduled - paid`, floored at zero. What's left to hand over. */
  outstanding: number;
  /** Principal only — what a payoff quote is built from. */
  principalScheduled: number;
  principalPaid: number;
  principalOutstanding: number;
  paidInstallments: number;
  totalInstallments: number;
}

/**
 * Envelope returned by the paginated list endpoints.
 *
 * `total` is the count matching the filter across all pages — not
 * `rows.length`. Both come from one transaction, so they always describe
 * the same snapshot.
 */
export interface Paginated<T> {
  rows: T[];
  total: number;
  /** The page actually served, after server-side clamping. */
  page: number;
  /** The page size actually used, after server-side clamping. */
  pageSize: number;
  /** At least 1, so an empty result reads "Page 1 of 1", not "of 0". */
  totalPages: number;
}

/** Page controls shared by every paginated list query. */
export interface PageQuery {
  /** 1-indexed. Out-of-range values are clamped server-side, not rejected. */
  page?: number;
  /**
   * Rows per page. Defaults to 200 server-side — the list endpoints also
   * feed the app's pickers, which want a pool rather than a page. The
   * tables pass a real page size.
   */
  pageSize?: number;
}

/**
 * Query-string for GET /loans. All optional — the bare call returns the
 * 200 most recent, as it always has.
 */
export interface LoanListQuery extends PageQuery {
  /** Scope to one borrower — powers the profile's loan history. */
  customerId?: string;
  /**
   * Free text over the loan number and the borrower's name / reference.
   * Tokenized server-side: "cruz salary" and "juan LN-2026" both work.
   */
  q?: string;
  status?: LoanStatus;
  productCode?: string;
}

/** Query-string for GET /customers. Same shape of contract as above. */
export interface CustomerListQuery extends PageQuery {
  /** Archived customers are excluded unless this is true. */
  includeArchived?: boolean;
  /**
   * Free text over reference number, name, phone, email and government
   * ID. Tokenized, so "dela cruz" and "cruz juan" both find the same
   * person.
   */
  q?: string;
  kycStatus?: KycStatus;
}

export interface LoanApplication {
  id: string;
  number: string;
  customerId: string;
  productCode: string;
  principal: string | number;
  termMonths: number;
  annualInterestRate: string | number;
  purpose: string | null;
  creditScoreAtApply: number | null;
  tierAtApply: CreditTier | null;
  status: LoanStatus;
  decisionReason: string | null;
  /**
   * 1-indexed pointer into the product's approval chain (if any). Null
   * when the product has no chain configured, or once all steps are done.
   */
  currentApprovalStep?: number | null;
  submittedAt: string;
  decidedAt: string | null;
  disbursedAt: string | null;
  closedAt: string | null;
  vehicleId: string | null;
  propertyId: string | null;
  vehicle?: Vehicle | null;
  property?: Property | null;
  product?: LoanProduct;
  applicationSelfieUrl: string | null;
  /**
   * Borrower. Present as a slim four-field projection on rows from
   * GET /loans (see {@link LoanListCustomer}) so the list can show and
   * search by who the loan is for; the detail endpoint carries the full
   * record. Absent on payloads that don't join it at all.
   */
  customer?: LoanListCustomer | null;
  /**
   * Where the loan actually stands, attached by the list endpoints.
   *
   * Null before disbursement: there are no instalments yet, and a zero
   * balance on an approved loan reads as "nothing to pay" rather than
   * "nothing scheduled yet".
   */
  balance?: LoanBalanceSummary | null;
  /**
   * KYC declaration snapshot — the product questionnaire + answers as
   * attested at apply (or completed later at the KYC stage). Null when
   * the product had no questionnaire at apply time.
   */
  kycDeclarations?: KycDeclarations | null;
  /** true when submitted by a customer with prior CLOSED loans. */
  isRepeat?: boolean;

  // ── Assisting agent ──────────────────────────────────────────────
  /** The field agent who brought this in. Null on direct applications. */
  agentId?: string | null;
  /**
   * Nested to match what the endpoint actually sends: the agent's name
   * lives on their User row, and the detail query joins it rather than
   * flattening. Kept honest to the wire instead of inventing a shape
   * the server never produces.
   */
  agent?: { id: string; number: string; user: { name: string } } | null;
  agentAssignedAt?: string | null;
  /**
   * Rate and amount FROZEN at assignment, not looked up live. A later
   * change to the agent's or the product's rate does not move them —
   * see the field comments in schema.prisma.
   */
  agentCommissionRate?: number | null;
  agentCommissionAmount?: number | null;
  /** Set when the commission was booked to the ledger, at disbursement. */
  agentCommissionPostedAt?: string | null;
  // Face-match (selfie ↔ ID) outputs. All four are null until an
  // officer runs the match on the loan detail page.
  selfieMatchScore?: number | null;
  selfieMatchDistance?: number | null;
  selfieMatchPassed?: boolean | null;
  selfieMatchModel?: string | null;
  selfieMatchedAt?: string | null;
  // E-signature audit
  borrowerSignatureUrl: string | null;
  borrowerSignedAt: string | null;
  borrowerSignedFromIp: string | null;
  officerSignatureUrl: string | null;
  officerSignedAt: string | null;
  officerSignedById: string | null;
  agreementHash: string | null;
  /** Populated by the detail endpoint. */
  schedule?: Array<{
    id: string;
    installmentNo: number;
    dueDate: string;
    principalDue: string | number;
    interestDue: string | number;
    totalDue: string | number;
    principalPaid: string | number;
    interestPaid: string | number;
    paidInFullAt: string | null;
  }>;
  /** Populated by the detail endpoint. */
  payments?: LoanPayment[];
}

export interface LoanApplyInput {
  customerId: string;
  productCode: string;
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  purpose?: string;
  vehicle?: VehicleInput;
  property?: PropertyInput;
  applicationSelfieUrl?: string;
  /**
   * The pre-assessment this application came out of, when the officer or
   * borrower reached the form from one. Links the two records; never
   * required, and a bad id is ignored rather than failing the apply.
   */
  preAssessmentId?: string;
  /** Answers to the product's declaration questionnaire, by question id. */
  kycAnswers?: KycAnswers;
}

export interface UploadResult {
  url: string;
  filename: string;
  mimetype: string;
}

// Jobs
export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface ScheduledJob {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobRun {
  id: string;
  jobId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
  manual: boolean;
}

// Notifications
export type NotificationChannel = "EMAIL" | "SMS" | "IN_APP";
export type NotificationStatus = "QUEUED" | "SENT" | "FAILED";
export type NotificationEvent =
  | "LOAN_APPROVED"
  | "LOAN_REJECTED"
  | "LOAN_DISBURSED"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_DUE_SOON"
  | "PAYMENT_OVERDUE"
  | "PROMISE_TO_PAY"
  | "WELCOME"
  | "TEST";

export interface Notification {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  providerRef: string | null;
  error: string | null;
  refType: string | null;
  refId: string | null;
  /**
   * The human reference the message text quotes — "LN-2026-000006".
   * Null on rows written before this existed, and on notifications
   * about things with no human reference. See `notificationLink`, which
   * prefers it over `refId` so the link says what the message says.
   */
  refNumber: string | null;
  customerId: string | null;
  createdAt: string;
  sentAt: string | null;
}

// AML screening
export type AmlStatus = "PENDING" | "CLEAR" | "MATCH" | "REVIEW" | "OVERRIDDEN";

export interface AmlScreening {
  id: string;
  customerId: string;
  status: AmlStatus;
  provider: string;
  providerRef: string | null;
  matches: Array<{
    list: string;
    matchedName: string;
    score: number;
    reason?: string;
  }> | null;
  notes: string | null;
  screenedAt: string;
  overriddenById: string | null;
  overriddenAt: string | null;
}

export interface AmlWatchlistEntry {
  id: string;
  list: string;
  fullName: string;
  aliases: string[];
  reason: string | null;
  createdAt: string;
}

// Analytics
export interface PortfolioSummary {
  asOf: string;
  activeLoans: number;
  totalOutstanding: number;
  originatedYtd: { count: number; principal: number };
  par30: number;
  par60: number;
  par90: number;
  nplRatio: number;
  cash: number;
  receivable: number;
}

export interface OriginationMonth {
  month: string;
  count: number;
  principal: number;
}

export interface VintageCohort {
  vintage: string;
  originated: number;
  currentlyOverdue90Plus: number;
  defaultRate: number;
}

// Co-makers
export type CoMakerRole = "CO_BORROWER" | "GUARANTOR" | "CO_MAKER";

/**
 * Where a co-maker stands on being one. A co-maker is jointly liable,
 * so agreeing is their decision rather than a box the officer ticks.
 */
export type CoMakerConsentStatus = "PENDING" | "APPROVED" | "DECLINED";

export interface CoMakerDocument {
  id: string;
  coMakerId: string;
  documentType: KycDocumentType;
  documentUrl: string;
  notes: string | null;
  uploadedAt: string;
}

/** What a co-maker sees when they open their invite link. */
export interface CoMakerInviteView {
  coMakerId: string;
  fullName: string;
  role: CoMakerRole;
  status: CoMakerConsentStatus;
  respondedAt: string | null;
  /** Which documents they're being asked for, from the loan product. */
  requiredDocuments: KycDocumentType[];
  documents: CoMakerDocument[];
  loan: {
    number: string;
    principal: number;
    termMonths: number;
    productName: string;
    borrowerName: string;
  };
  lender: { companyName: string };
}

export interface CoMaker {
  id: string;
  loanId: string;
  /**
   * The registered customer standing as co-maker. Null only on rows
   * created before co-makers had to be customers — see the migration.
   */
  customerId: string | null;
  /**
   * Snapshot taken when they were added, not a live join: the consent
   * record and the signed agreement have to name the person who
   * actually agreed, whatever their customer record says later.
   */
  fullName: string;
  role: CoMakerRole;
  relationship: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  governmentIdType: GovernmentIdType | null;
  governmentIdNumber: string | null;
  monthlyIncome: string | number | null;
  signedAgreementUrl: string | null;
  notes: string | null;
  status: CoMakerConsentStatus;
  respondedAt: string | null;
  declineReason: string | null;
  inviteSentAt: string | null;
  inviteExpiresAt: string | null;
  /**
   * When the consent link was first opened; null means never.
   *
   * The closest thing to presence a co-maker can have — they hold no
   * account, so this request is the only evidence the link reached a
   * person. Paired with `inviteSentAt` it separates "they've seen it
   * and are hesitating" from "it never arrived".
   */
  linkOpenedAt: string | null;
  documents?: CoMakerDocument[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Adding a co-maker — a REGISTERED CUSTOMER, not a typed-in name.
 *
 * Identity is deliberately absent. Name, phone, email, address and ID
 * are snapshotted from the Customer row by the API, so a typed name and
 * a chosen customer can never disagree. What's left is what belongs to
 * this particular guarantee rather than to the person.
 */
export interface CoMakerInput {
  customerId: string;
  role?: CoMakerRole;
  relationship?: string;
  signedAgreementUrl?: string;
  notes?: string;
}

// Decision rules
export type RuleAction = "AUTO_APPROVE" | "AUTO_REJECT" | "MANUAL_REVIEW";
export type DecisioningOp =
  "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not_in";

export interface DecisioningCondition {
  field: string;
  op: DecisioningOp;
  value: string | number | boolean | Array<string | number>;
}

export interface DecisionRule {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason: string | null;
  active: boolean;
  /**
   * Which revision this is. Bumped only by changes that alter an
   * OUTCOME — conditions, action, priority, reason, active. Renaming a
   * rule leaves it alone, so the history stays worth reading.
   */
  version: number;
  /** When the current version took effect. */
  effectiveFrom: string;
  /** Set when the rule was withdrawn. Retired rules never appear in
   * listings; the field is here because a version row can name one. */
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DecisionRuleChangeType = "CREATE" | "UPDATE" | "RETIRE";

/**
 * One frozen revision of a rule.
 *
 * The window [effectiveFrom, effectiveTo) is when this text of the rule
 * was the one in force. `effectiveTo` is null on the current version,
 * and equal to `effectiveFrom` on a RETIRE row — a zero-width window,
 * because that row records a withdrawal rather than a period.
 */
export interface DecisionRuleVersion {
  id: string;
  ruleId: string;
  version: number;
  ruleName: string;
  description: string | null;
  priority: number;
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason: string | null;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  changeType: DecisionRuleChangeType;
  changeNote: string | null;
  changedById: string | null;
}

export interface DecisionRuleInput {
  name: string;
  description?: string;
  priority?: number;
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason?: string;
  active?: boolean;
}

// RBAC
/**
 * Lifecycle gate on each permission row. `DRAFT` keeps a permission
 * present in the catalog but suppresses it at resolve time, so admins
 * can wire role membership before the perm goes live. `DEPRECATED`
 * still grants at runtime (so in-flight flows don't break) but is
 * flagged in the UI for planned removal.
 */
export type PermissionStatus = "DRAFT" | "ACTIVE" | "DEPRECATED";

export interface Permission {
  id: string;
  key: string;
  label: string;
  description: string | null;
  category: string;
  system: boolean;
  status: PermissionStatus;
  createdAt: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleWithPermissions extends Role {
  permissions: Array<{ permission: Permission }>;
  /**
   * Immediate inheritance edges. The resolver expands these
   * transitively at permission-check time; this list is the
   * editable surface.
   */
  parents?: Array<{ parent: Role }>;
  _count?: { users: number };
}

export interface RoleCreateInput {
  key: string;
  name: string;
  description?: string;
  permissions?: string[];
  /**
   * Optional inheritance — role keys whose permissions this role
   * picks up at resolve time. Cycles are rejected server-side.
   */
  parents?: string[];
}

export interface RoleUpdateInput {
  name?: string;
  description?: string;
  permissions?: string[];
  parents?: string[];
}

/**
 * Presence, resolved by the API against ITS clock.
 *
 * `NEVER` is kept apart from `OFFLINE` because "has not signed in since
 * we started counting" and "was here this morning" are different facts
 * about a person; collapsing them would make a dormant account look
 * merely idle.
 */
export type UserPresence = "ONLINE" | "OFFLINE" | "NEVER";

export interface UserWithRoles {
  id: string;
  email: string;
  name: string;
  primaryRole: UserRole;
  active: boolean;
  createdAt: string;
  /** ISO-8601, or null if they have never made an authenticated request. */
  lastSeenAt: string | null;
  /**
   * Computed server-side on purpose. Deriving it in the browser would
   * make the badge a function of how accurately the viewer's own clock
   * is set — a laptop ten minutes fast would show the whole company as
   * offline. `lastSeenAt` is still sent, for the relative label where
   * a few seconds of drift costs nothing.
   */
  presence: UserPresence;
  /**
   * Whether the user currently holds any live refresh token.
   *
   * Deliberately NOT the same question as `presence`. Someone idle
   * since this morning reads OFFLINE but is still signed in, and
   * ending their session is a real act; someone who has never signed
   * in has nothing to end. The Users page uses this to decide whether
   * "Sign out everywhere" is worth offering at all.
   */
  hasActiveSession: boolean;
  /**
   * `expiresAt` is null for perpetual grants; an ISO-8601 string
   * otherwise. A date in the past means the assignment row is still on
   * file (audit) but no longer contributes to effective permissions.
   */
  roles: Array<{
    key: string;
    name: string;
    system: boolean;
    expiresAt: string | null;
  }>;
}

/**
 * Single role assignment row — returned by
 * `GET /admin/users/:userId/roles`. `expiresAt: null` means perpetual;
 * a date in the past means the assignment is no longer active (the
 * resolver filters it out of effective permissions). The row is kept
 * for audit purposes even after expiry.
 */
export interface UserRoleAssignmentRow {
  userId: string;
  roleId: string;
  grantedAt: string;
  grantedById: string | null;
  expiresAt: string | null;
  role: { id: string; key: string; name: string; system: boolean };
}

export interface MePermissions {
  permissions: string[];
  roles: Array<{ key: string; name: string; system: boolean }>;
}

/**
 * Response of `GET /admin/permissions/:key/holders` — answers "who
 * currently holds permission X?" by splitting grants into direct role
 * membership vs active delegation. See `RbacService.listPermissionHolders`
 * for the full semantics.
 */
export interface PermissionHolderDelegation {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  startsAt: string;
  endsAt: string;
  /** True when the delegation explicitly listed this key. False when it
   * comes via the "all of my perms" rule (the delegator currently
   * holds the key and the delegation has an empty `permissions[]`). */
  viaExplicit: boolean;
}

export interface PermissionHoldersPayload {
  permission: {
    key: string;
    label: string;
    description: string | null;
    category: string;
  };
  directRoles: Array<{
    key: string;
    name: string;
    system: boolean;
    userCount: number;
  }>;
  delegations: PermissionHolderDelegation[];
  /** Deduped count across role assignments + active delegations. */
  totalActiveUsers: number;
}

/**
 * Response of `POST /admin/roles/:key/edit-impact` — preview of the
 * downstream effect of a proposed role permission change. The dialog
 * uses this to show "X users will lose perm Z" before save commits.
 * `usersLosing` counts active users for whom this role is the *only*
 * grant of the permission — users with overlapping role grants are
 * unaffected and not counted.
 */
export interface RoleEditImpact {
  role: { key: string; name: string; system: boolean };
  removed: Array<{ key: string; label: string; usersLosing: number }>;
  addedKeys: string[];
}

/**
 * One row of the response of `POST /admin/users/bulk-import`. Each row
 * corresponds to one input row (index matches input order). On success
 * `id` is the new user UUID; on failure `error` is a human-readable
 * reason ("email already in use", "extra role 'FOO' not found", etc.).
 *
 * `dryRun` runs pass through the same validation but skip the actual
 * insert; the result still echoes `index` + `email` + `ok` so the UI
 * can render a preview table.
 */
export type BulkUserRowResult =
  | { index: number; ok: true; id?: string; email: string }
  | { index: number; ok: false; error: string };

export interface BulkUserImportResponse {
  results: BulkUserRowResult[];
  succeeded: number;
  failed: number;
  dryRun: boolean;
}

export interface BulkUserImportInput {
  rows: Array<{
    email: string;
    name: string;
    password: string;
    role: UserRole;
    customerId?: string;
    extraRoles?: string | string[];
  }>;
  /** Halt at the first failure. Default: continue + return 207 multi-status. */
  stopOnError?: boolean;
  /** Validate only — no inserts. Useful for the UI preview step. */
  dryRun?: boolean;
}

// Delegation — time-bounded proxy authority
export interface Delegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  /** Empty array = blanket — delegate inherits *all* of delegator's permissions. */
  permissions: string[];
  startsAt: string;
  endsAt: string;
  note: string | null;
  revokedAt: string | null;
  revokedById: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationListForUser {
  granted: Delegation[];
  held: Delegation[];
}

/**
 * Response of `GET /delegations/:id/preview`. Answers "what does this
 * delegation actually grant me right now?". See
 * `DelegationService.previewResolvedPermissions` for semantics.
 *
 *   - `resolvedPermissions` is what the delegate would inherit if
 *     they exercised the delegation right now.
 *   - `droppedPermissions` lists explicit keys the delegator no
 *     longer holds — non-empty when something changed on the
 *     delegator's side since the delegation was created.
 */
export interface DelegationPreview {
  delegation: {
    id: string;
    delegatorId: string;
    delegateId: string;
    startsAt: string;
    endsAt: string;
    permissions: string[];
    revokedAt: string | null;
  };
  resolvedPermissions: string[];
  droppedPermissions: string[];
  isActiveNow: boolean;
}

export interface DelegationCreateInput {
  delegateId: string;
  delegatorId?: string;
  permissions?: string[];
  startsAt: string;
  endsAt: string;
  note?: string;
}

export interface AmortizationRow {
  installmentNo: number;
  principal: number;
  interest: number;
  payment: number;
  balance: number;
}

export interface LoanPayment {
  id: string;
  loanId: string;
  amount: string | number;
  paidOn: string;
  reference: string | null;
  notes: string | null;
}

// Accounting
export type AccountType =
  "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type NormalBalance = "DEBIT" | "CREDIT";
export type JournalSource =
  "MANUAL" | "LOAN_DISBURSEMENT" | "LOAN_PAYMENT" | "REVERSAL" | "ADJUSTMENT";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  description: string | null;
  active: boolean;
  system: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JournalLine {
  id: string;
  entryId: string;
  accountId: string;
  debit: string | number;
  credit: string | number;
  memo: string | null;
  account?: Account;
}

export interface JournalEntry {
  id: string;
  number: string;
  entryDate: string;
  memo: string | null;
  source: JournalSource;
  sourceRefType: string | null;
  sourceRefId: string | null;
  postedAt: string;
  postedById: string;
  postedBy?: { id: string; name: string };
  lines?: JournalLine[];
  /** Id of the reversing entry, if this entry has been reversed. */
  reversedById?: string | null;
}

export interface JournalEntryCreateInput {
  entryDate: string;
  memo?: string;
  lines: Array<{
    accountCode: string;
    debit?: number;
    credit?: number;
    memo?: string;
  }>;
}

export interface LedgerLine {
  lineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  source: JournalSource;
  memo: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
}

export interface TrialBalanceReport {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  inBalance: boolean;
}

export interface IncomeStatementReport {
  from: string;
  to: string;
  income: {
    rows: Array<{ code: string; name: string; amount: number }>;
    total: number;
  };
  expense: {
    rows: Array<{ code: string; name: string; amount: number }>;
    total: number;
  };
  netIncome: number;
}

export interface BalanceSheetReport {
  asOf: string;
  assets: {
    rows: Array<{ code: string; name: string; amount: number }>;
    total: number;
  };
  liabilities: {
    rows: Array<{ code: string; name: string; amount: number }>;
    total: number;
  };
  equity: {
    rows: Array<{ code: string; name: string; amount: number }>;
    total: number;
  };
  retainedEarnings: number;
  totalLiabilitiesAndEquity: number;
  inBalance: boolean;
}

/**
 * Seven bands. `D_90_PLUS` used to pool a loan 95 days late with one
 * three years gone — different assets, different provisioning, different
 * collection decision. Mirrors @loan/accounting's AgingBucket.
 */
export type AgingBucket =
  | "CURRENT"
  | "D_1_30"
  | "D_31_60"
  | "D_61_90"
  | "D_91_120"
  | "D_121_180"
  | "D_180_PLUS";

export interface AgingRow {
  loanId: string;
  loanNumber: string;
  customerName: string;
  installmentsOverdue: number;
  outstandingBalance: number;
  bucket: AgingBucket;
  daysOverdue: number;
}

/**
 * `rows` is one PAGE of per-loan detail; `totals`, `totalOutstanding`
 * and `total` always describe the WHOLE book, on every page.
 *
 * Read `total` — never `rows.length` — for the number of loans in the
 * report. They were the same thing until the rows were paginated
 * (finding F4 in docs/modernization/query-performance.md), and the
 * difference does not announce itself: `rows.length` now silently means
 * "page size".
 */
export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  totals: Record<AgingBucket, number>;
  totalOutstanding: number;
  /** Loans in the report across all pages. */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Roll-rate analysis (§30) — how delinquency moved between the aging
 * bands across two dates. Mirrors @loan/accounting's roll-rate.ts.
 * "NEW" is the origin row for loans disbursed inside the window;
 * CLOSED/WRITTEN_OFF are the two ways off the book.
 */
export type RollRateOrigin = AgingBucket | "NEW";
export type RollRateDestination = AgingBucket | "CLOSED" | "WRITTEN_OFF";

export interface RollRateCell {
  destination: RollRateDestination;
  count: number;
  /** Gross exposure at `from` (at `to` for the NEW origin row). */
  amount: number;
  countFraction: number;
  amountFraction: number;
}

export interface RollRateMatrixRow {
  origin: RollRateOrigin;
  loanCount: number;
  amount: number;
  /** One cell per entry of `destinations`, in that order. */
  cells: RollRateCell[];
}

export interface RollRateReport {
  from: string;
  to: string;
  totalLoans: number;
  origins: RollRateOrigin[];
  destinations: RollRateDestination[];
  overall: RollRateMatrixRow[];
  byProduct: Array<{ productCode: string; rows: RollRateMatrixRow[] }>;
}

/**
 * Product profitability (§54) — mirrors @loan/accounting's
 * profitability.ts. All money figures are EXACT DECIMAL STRINGS
 * ("365.00", "-3700.00"): the builder sums integer centavos and the API
 * ships the strings verbatim so no float ever touches a peso.
 */
export interface ProfitabilityFigures {
  interestIncome: string;
  feeIncome: string;
  lateFeeIncome: string;
  writeOffLoss: string;
  net: string;
}

export interface ProductProfitabilityRow extends ProfitabilityFigures {
  productCode: string;
  productName: string;
  loanCount: number;
}

export interface ProductProfitabilityReport {
  from: string;
  to: string;
  products: ProductProfitabilityRow[];
  /** In-scope ledger money no product claims — reported, not dropped. */
  unattributed: ProfitabilityFigures & { entryCount: number };
  /** Product rows plus the unattributed bucket. */
  totals: ProfitabilityFigures;
}

export type PeriodStatus = "OPEN" | "CLOSED";

export interface AccountingPeriod {
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  closedAt: string | null;
  closedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccrualJobResult {
  posted: number;
  skipped: number;
}

// Collections
export type CollectionNoteType = "CALL" | "SMS" | "EMAIL" | "VISIT" | "OTHER";
export type PromiseStatus = "PROMISED" | "HONORED" | "BROKEN" | "CANCELLED";

export interface CollectionNote {
  id: string;
  loanId: string;
  type: CollectionNoteType;
  body: string;
  createdAt: string;
  createdById: string;
}

export interface PromiseToPay {
  id: string;
  loanId: string;
  amount: string | number;
  promisedDate: string;
  status: PromiseStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  createdById: string;
}

// Payments
export type PaymentProviderName = "MOCK" | "GCASH" | "MAYA";
export type PaymentIntentStatus =
  "CREATED" | "PROCESSING" | "PAID" | "FAILED" | "EXPIRED";

export interface PaymentIntent {
  id: string;
  /** Human-readable reference number ("PI-2026-000123"). */
  number: string;
  loanId: string;
  provider: PaymentProviderName;
  externalId: string;
  idempotencyKey: string;
  amount: string | number;
  paymentUrl: string;
  status: PaymentIntentStatus;
  resolvedAt: string | null;
  paymentId: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

// ─── Lease-to-Own ───────────────────────────────────────────────────────────

export type LeaseStatus =
  "ACTIVE" | "PULLED_OUT" | "BUYOUT_COMPLETED" | "RETURNED" | "EXTENDED";

export type LeaseTitleHolder = "COMPANY" | "CUSTOMER";

export interface LeaseAgreement {
  id: string;
  loanId: string;
  status: LeaseStatus;
  residualValue: string | number;
  titleHolder: LeaseTitleHolder;
  isEmployee: boolean;
  missedPaymentStreak: number;
  lastPullOutWarningAt: string | null;
  endOfTermNoticeSentAt: string | null;
  lastMaintenanceReminderAt: string | null;
  buyoutPaidAmount: string | number | null;
  buyoutAt: string | null;
  buyoutById: string | null;
  buyoutJournalEntryId: string | null;
  pulledOutAt: string | null;
  pulledOutById: string | null;
  pullOutReason: string | null;
  closedAt: string | null;
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaseAgreementWithLoan extends LeaseAgreement {
  loan: { number: string; customerId: string };
}

// ─── DORSI compliance ───────────────────────────────────────────────────────

export type DorsiCategory =
  "DIRECTOR" | "OFFICER" | "STOCKHOLDER" | "RELATED_INTEREST";

/**
 * Minimum length of a DORSI basis.
 *
 * The basis is what a BSP examiner reads to see why this customer was
 * classified DORSI, so it has to carry a relationship rather than an
 * abbreviation — "Treasurer since 2021", not "CFO". Ten characters is
 * the shortest that reliably rules out a placeholder while still
 * accepting every legitimate phrasing we found in the register.
 *
 * Lives here so the dialog and the API can't drift: a client-side
 * minimum the server doesn't share is a suggestion, not a rule.
 *
 * Existing records are untouched — this validates writes only, so a
 * record tagged under the old 3-character rule stays valid until
 * someone re-tags it.
 */
export const DORSI_BASIS_MIN_LENGTH = 10;

/** Per-category examples of a basis that actually explains itself. */
export const DORSI_BASIS_EXAMPLE: Record<DorsiCategory, string> = {
  DIRECTOR: "Board director since March 2022",
  OFFICER: "Chief Finance Officer since 2021",
  STOCKHOLDER: "Holds 12% of outstanding shares",
  RELATED_INTEREST: "Spouse of director Ana Cruz",
};

export interface DorsiRecord {
  id: string;
  customerId: string;
  category: DorsiCategory;
  basis: string;
  active: boolean;
  lastReviewedAt: string | null;
  lastReviewedById: string | null;
  taggedAt: string;
  taggedById: string;
  deactivatedAt: string | null;
  deactivatedById: string | null;
  deactivationReason: string | null;
}

export interface DorsiRecordWithCustomer extends DorsiRecord {
  customer: {
    // `number` is the CUST-YYYY-NNNNNN reference. Used by UI callsites
    // so they can link via the human number instead of the raw UUID.
    number: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
}

export interface DorsiUtilization {
  /**
   * False when `companyTotalEquity` is zero — the caps are 0 and every
   * percentage below is meaningless. The UI must render "unconfigured"
   * rather than the 0% the numbers would otherwise show: a zero cap
   * means NO DORSI lending headroom exists, which is the opposite of
   * all-clear.
   */
  configured: boolean;
  companyTotalEquity: number;
  aggregateCap: number;
  aggregateOutstanding: number;
  aggregateUtilizationPct: number;
  individualCap: number;
  perBorrower: Array<{
    customerId: string;
    /** CUST-YYYY-NNNNNN reference for the borrower. */
    customerNumber: string;
    customerName: string;
    category: DorsiCategory;
    outstanding: number;
    utilizationPct: number;
  }>;
}

export interface DorsiLoanCheck {
  status: "OK" | "BOARD_REQUIRED" | "NOT_DORSI";
  aggregateOutstanding: number;
  aggregateCap: number;
  individualOutstanding: number;
  individualCap: number;
  projectedAggregateUtilization: number;
  projectedIndividualUtilization: number;
  message: string;
}

export interface DorsiBoardApproval {
  id: string;
  loanId: string;
  aggregateUtilizationPct: number;
  individualUtilizationPct: number;
  meetingDate: string;
  minutesRef: string | null;
  note: string | null;
  approvedAt: string;
  approvedById: string;
}

export interface SystemConfig {
  companyTotalEquity: number;
  updatedAt: string;
  updatedById: string | null;
}

// ─── Repossession ───────────────────────────────────────────────────────────

export type RepossessionStatus =
  | "IDENTIFIED"
  | "BM_APPROVED"
  | "CREDIT_HEAD_APPROVED"
  | "LEGAL_APPROVED"
  | "AGENT_ASSIGNED"
  | "RECOVERED"
  | "AUCTIONED"
  | "CLOSED"
  | "CANCELLED";

export interface RepossessionCase {
  id: string;
  loanId: string;
  status: RepossessionStatus;
  reason: string;
  identifiedAt: string;
  identifiedById: string;

  bmApprovedAt: string | null;
  bmApprovedById: string | null;
  bmApprovalNote: string | null;
  creditHeadApprovedAt: string | null;
  creditHeadApprovedById: string | null;
  creditHeadApprovalNote: string | null;
  legalApprovedAt: string | null;
  legalApprovedById: string | null;
  legalApprovalNote: string | null;

  agentName: string | null;
  agentContact: string | null;
  agentAssignedAt: string | null;
  agentAssignedById: string | null;

  recoveredAt: string | null;
  recoveredById: string | null;
  vehicleCondition: string | null;
  vehicleMileage: number | null;
  vehiclePhotos: string | null;
  storageLocation: string | null;

  auctionedAt: string | null;
  auctionedById: string | null;
  auctionMethod: string | null;
  auctionProceeds: string | number | null;
  outstandingAtRecovery: string | number | null;
  deficiency: string | number | null;
  journalEntryId: string | null;

  cancelledAt: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
}

export interface RepossessionCaseWithLoan extends RepossessionCase {
  loan: { number: string; customerId: string };
}

// ─── Demand letters ─────────────────────────────────────────────────────────

export type DemandLetterStage =
  "FIRST" | "FINAL" | "ATTORNEY_FIRST" | "ATTORNEY_FINAL";

export type DemandLetterStatus =
  "DRAFTED" | "APPROVED" | "DISPATCHED" | "RESPONDED" | "WAIVED";

export interface DemandLetter {
  id: string;
  loanId: string;
  stage: DemandLetterStage;
  status: DemandLetterStatus;
  principalOwed: string | number;
  interestOwed: string | number;
  penaltiesOwed: string | number;
  totalOwed: string | number;
  daysOverdue: number;
  paymentDeadline: string;
  body: string;
  draftedAt: string;
  draftedById: string;
  approvedAt: string | null;
  approvedById: string | null;
  approvalNote: string | null;
  dispatchedAt: string | null;
  dispatchedById: string | null;
  dispatchChannel: string | null;
  dispatchRef: string | null;
  closedAt: string | null;
  closedById: string | null;
  closedReason: string | null;
}

export interface DemandLetterWithLoan extends DemandLetter {
  loan: { number: string; customerId: string };
}

/** Identification result — a loan eligible for a demand letter at a stage. */
export interface DemandCandidate {
  loanId: string;
  loanNumber: string;
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string;
  principalOwed: number;
  interestOwed: number;
  penaltiesOwed: number;
  totalOwed: number;
  daysOverdue: number;
  lastLetterAtStageId: string | null;
  lastLetterAtStageAt: string | null;
}

// ─── Annual / renewable documents ───────────────────────────────────────────

export type AnnualDocumentType =
  "CAR_INSURANCE" | "OR_CR" | "RPT" | "FIRE_INSURANCE" | "OTHER";

export type AnnualDocumentStatus = "VALID" | "EXPIRING_SOON" | "EXPIRED";

export interface AnnualDocument {
  id: string;
  loanId: string;
  type: AnnualDocumentType;
  name: string;
  documentUrl: string | null;
  effectiveFrom: string;
  expiresAt: string;
  status: AnnualDocumentStatus;
  notes: string | null;
  submittedAt: string;
  submittedById: string;
  lastReminderAt: string | null;
  reminderCount: number;
}

export interface AnnualDocumentCreateInput {
  type: AnnualDocumentType;
  name: string;
  documentUrl?: string;
  effectiveFrom: string;
  expiresAt: string;
  notes?: string;
}

/** Result row of GET /annual-docs/expiring — joins the loan for the dashboard. */
export interface ExpiringAnnualDocument extends AnnualDocument {
  loan: { number: string; customerId: string };
}

// ─── Penalty waive ──────────────────────────────────────────────────────────

export interface LoanPenaltyTotals {
  originalPenalty: number;
  waivedToDate: number;
  /** Late fee the borrower has actually paid. `outstanding` is net of it. */
  paidToDate: number;
  outstanding: number;
}

export interface PenaltyWaiver {
  id: string;
  loanId: string;
  originalPenalty: string | number;
  waivedAmount: string | number;
  negotiatedPenalty: string | number;
  reason: string;
  journalEntryId: string | null;
  waivedById: string;
  waivedAt: string;
  waivedBy?: { id: string; name: string; email: string };
}

// ─── Customer rollup (drawer) ───────────────────────────────────────────────

export interface CustomerSummary {
  customer: Customer;
  activeLoansCount: number;
  totalLoansCount: number;
  /** Open principal across all DISBURSED/ACTIVE/DEFAULTED loans. */
  outstanding: number;
  activeLoans: Array<{
    id: string;
    number: string;
    productCode: string;
    principal: string | number;
    status: LoanStatus;
    disbursedAt: string | null;
  }>;
}

// ─── Consolidated exposure ──────────────────────────────────────────────────

/**
 * One loan's line in the consolidated view.
 *
 * `counted` says whether this row is inside the totals. Rows that
 * aren't — closed, restructured, written off, never granted — are still
 * returned: an exposure report an officer cannot reconcile against the
 * loan list is one they won't trust, and a write-off that quietly
 * disappears is how the same borrower gets lent to twice.
 */
export interface ExposureLoanLine {
  loanId: string;
  loanNumber: string;
  productCode: string;
  /** Catalog display name, when the product still has one. */
  productName: string | null;
  status: LoanStatus;
  /** Contracted principal — what the loan was written for. */
  principal: number;
  /** Principal still owed. */
  principalOutstanding: number;
  /** Principal plus scheduled interest still owed. */
  outstanding: number;
  /** Unpaid and past its due date, as of `CustomerExposure.asOf`. */
  pastDue: number;
  /** How many instalments make up `pastDue`. */
  overdueInstallments: number;
  counted: boolean;
  /**
   * False when the loan has no schedule yet (approved, not disbursed)
   * and the figures stand in at the contracted principal. A commitment,
   * not a receivable.
   */
  fromSchedule: boolean;
  /**
   * What actually went to Bad Debt on a WRITTEN_OFF loan — the balance
   * at write-off, not the contracted principal. Zero on every other
   * status.
   */
  writtenOff: number;
}

export interface ExposureTotals {
  /** The headline: total principal this borrower still owes. */
  principalOutstanding: number;
  /** The same debt including scheduled interest. */
  outstanding: number;
  pastDue: number;
  /** How many loans the totals are made of. */
  activeLoans: number;
}

/** Loans deliberately outside the totals, reported rather than dropped. */
export interface ExposureExcluded {
  loans: number;
  closedLoans: number;
  writtenOffLoans: number;
  /** Principal the lender already expensed to Bad Debt. */
  /**
   * What the lender expensed to Bad Debt: the balance at write-off, not
   * the sum of the contracted amounts.
   */
  writtenOffPrincipal: number;
}

/**
 * Response shape of GET /customers/:idOrNumber/exposure — everything one
 * borrower owes, across every loan they hold. The figure credit
 * decisioning, DTI and concentration limits are all asking for.
 *
 * Derived on every read from loans and their schedules; nothing about
 * it is stored, so it can't go stale.
 */
export interface CustomerExposure {
  customerId: string;
  customerNumber: string;
  /** When arrears were measured. "Past due" means nothing without it. */
  asOf: string;
  loans: ExposureLoanLine[];
  total: ExposureTotals;
  excluded: ExposureExcluded;
}

/**
 * Returned by GET /customers/:id/repeat-eligibility., a
 * customer qualifies for the repeat-borrower fast path when at least one
 * prior loan has closed cleanly (no defaults, no write-offs) and their
 * KYC pack is verified.
 */
export interface RepeatEligibility {
  customerId: string;
  eligible: boolean;
  closedLoansCount: number;
  defaultedLoansCount: number;
  writtenOffLoansCount: number;
  lastClosedAt: string | null;
  kycVerified: boolean;
}

/**
 * Response shape of POST /loans/dry-run — pre-decisioning preview the
 * "smart" new-loan dialog calls on every debounced edit so the officer
 * can see how the rules engine would treat the application before
 * pressing Submit.
 */
export interface LoanDryRunInput {
  customerId: string;
  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a decimal, e.g. 0.24 for 24% APR. */
  annualInterestRate: number;
}

export interface LoanDryRunResult {
  verdict: "APPROVE" | "REVIEW" | "REJECT";
  /** Human-readable explanation — mirrors the rule's `reason` field. */
  reason: string;
  /** The first rule that matched, if any. Null when no rule fired. */
  matchedRule: { id: string; name: string } | null;
  /** Non-rule blocking conditions the UI should surface separately. */
  gates: {
    /** True iff the customer has an unresolved AML MATCH. */
    amlMatch: boolean;
    /** True iff every required KYC doc is VERIFIED. */
    kycComplete: boolean;
    missingKycDocs: KycDocumentType[];
    rejectedKycDocs: KycDocumentType[];
  };
  /**
   * Statistical anomaly flags vs. the historical baseline for this
   * product, plus domain-specific sanity checks (applicant velocity,
   * principal-to-income). Empty array when nothing's unusual.
   */
  anomalies: AnomalyFlag[];
  /** Snapshot of the decisioning context — useful for diagnostics. */
  context: {
    principal: number;
    termMonths: number;
    annualInterestRate: number;
    productCode: string;
    creditScore: number | null;
    tier: CreditTier | null;
    monthlyIncome: number;
    existingActiveLoans: number;
  };
}

/**
 * ─── Pre-assessment ────────────────────────────────────────────────
 *
 * A saved run of the rules engine against a prospective loan, taken
 * before any application exists. Two producers:
 *
 *   • POST /portal/pre-assessments   — borrower checks themselves.
 *   • POST /pre-assessments          — staff check a walk-in prospect
 *                                      (or an existing customer).
 *
 * Distinct from POST /loans/dry-run, which previews one in-flight
 * application inside the officer's wizard and persists nothing.
 */

export type PreAssessmentVerdict = "APPROVE" | "REVIEW" | "REJECT";
export type PreAssessmentSource = "PORTAL" | "OFFICER";

/**
 * Officer-side request. Supply `customerId` to assess someone already on
 * file — score, AML and KYC are then read off their record. Supply the
 * `prospect*` fields instead for a walk-in with no Customer row, in which
 * case the verdict is indicative only (see `basis` on the response).
 */
export interface PreAssessmentInput {
  customerId?: string;
  prospectName?: string;
  prospectPhone?: string;
  prospectEmail?: string;
  /** Required when there's no customerId — nothing to read it from. */
  monthlyIncome?: number;
  /** Required when there's no customerId. Years. */
  applicantAge?: number;
  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a decimal, e.g. 0.24 for 24% APR. */
  annualInterestRate: number;
}

/** Borrower-side request. The customer is the caller, so it isn't named. */
export type PortalPreAssessmentInput = Pick<
  PreAssessmentInput,
  "productCode" | "principal" | "termMonths" | "annualInterestRate"
>;

// ─── Field agents ────────────────────────────────────────────────────────

/** Whether a loan's commission rate came from the agent or the product. */
export type CommissionRateSource = "AGENT_OVERRIDE" | "PRODUCT_DEFAULT";

export interface AgentBookTotals {
  loanCount: number;
  fundedCount: number;
  /** Commission on loans that reached disbursement — what they were paid. */
  earned: number;
  /** Commission riding on applications still in flight. Not banked. */
  pipeline: number;
}

export interface Agent {
  id: string;
  /** "AGT-2026-000007". */
  number: string;
  userId: string;
  name: string;
  email: string;
  /** Null means "inherit the product's rate", which is the usual case. */
  commissionRate: number | null;
  territory: string | null;
  notes: string | null;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  totals: AgentBookTotals;
}

export interface AgentBookLoan {
  id: string;
  number: string;
  status: LoanStatus;
  productCode: string;
  principal: number;
  submittedAt: string;
  disbursedAt: string | null;
  customerName: string;
  customerNumber: string;
  /** Frozen on the loan at assignment, not looked up live. */
  commissionRate: number | null;
  commissionAmount: number | null;
  /** Set when the commission was booked to the ledger, at disbursement. */
  commissionPostedAt: string | null;
}

export interface AgentBook {
  agent: Agent;
  loans: AgentBookLoan[];
  /** Over the whole book, never the visible page. */
  totals: AgentBookTotals;
}

/**
 * What the coop owes an agent right now, and the loans behind it.
 *
 * Distinct from `AgentBookTotals.earned`, which is PAYABLE + PAID over
 * a whole career. Handing that figure to a cashier would pay every
 * commission the agent has ever made, all over again.
 */
export interface AgentPayable {
  agent?: Agent;
  loans: Array<{
    loanId: string;
    loanNumber: string;
    customerName: string;
    principal: number;
    commissionAmount: number;
    /** When the commission hit the ledger — i.e. when it became owed. */
    postedAt: string;
  }>;
  payableTotal: number;
  paidTotal: number;
  /** Present on the agent's own view (/agents/me/payable). */
  payouts?: AgentPayout[];
}

export interface AgentPayout {
  id: string;
  /** "APO-2026-000012". */
  number: string;
  agentId: string;
  agentNumber: string;
  agentName: string;
  amount: number;
  paidOn: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  /** Voided, never deleted — the reversal stands beside the original. */
  voidedAt: string | null;
  voidReason: string | null;
  /** Exactly which commissions this payment settled. */
  items: Array<{ loanId: string; loanNumber: string; amount: number }>;
}

/**
 * A row of the KYC review queue: the document, plus who it belongs to.
 *
 * Joined server-side on purpose. The queue used to be assembled in the
 * browser from the customer pool plus one request per customer, which
 * both asked the wrong question and asked it two hundred times.
 */
export interface PendingKycRow {
  id: string;
  number: string;
  customerId: string;
  customerNumber: string;
  customerName: string;
  customerPhone: string;
  documentType: KycDocumentType;
  documentUrl: string;
  status: KycSubmissionStatus;
  submittedAt: string;
}

// ─── Data privacy (DSAR + retention) ─────────────────────────────────────

export interface RetentionPolicyView {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  /**
   * The login-attempt security log's own window. Separate from the audit
   * one on purpose: the audit window is pinned to the AMLA §9 floor by
   * what audit rows evidence, and this log is high-volume personal data
   * with no such floor under it.
   */
  loginAttemptRetentionDays: number;
  /**
   * True when the audit window is under the AMLA §9 five-year floor.
   * The server computes it; the UI's job is to make it unmissable, not
   * to re-derive it.
   */
  auditBelowAmlaFloor: boolean;
}

export interface RetentionPurgeResult {
  startedAt: string;
  finishedAt: string;
  policy: {
    auditRetentionDays: number;
    notificationRetentionDays: number;
    jobRunRetentionDays: number;
    loginAttemptRetentionDays: number;
  };
  /** Null when a window is 0 ("never purge") — nothing was cut off. */
  cutoffs: {
    audit: string | null;
    notification: string | null;
    jobRun: string | null;
    loginAttempt: string | null;
  };
  deleted: {
    auditEvents: number;
    notifications: number;
    jobRuns: number;
    loginAttempts: number;
  };
  /**
   * Audit rows whose `ipAddress`/`userAgent` were nulled in place rather
   * than deleted — the §71 path for records §56 will not let go.
   *
   * Kept out of `deleted` deliberately: "we minimised the personal data on
   * a record we kept" and "we destroyed a record" are different answers to
   * a regulator, and one number cannot carry both.
   */
  redacted: {
    auditEvents: number;
  };
  /** The closed list of audit actions the run was permitted to delete. */
  auditActionsInScope: string[];
}

/**
 * What an erasure actually did. Surfaced verbatim in the UI, because
 * "erased" without the two lists invites both wrong readings — that
 * everything is gone (the financial records are not), and that nothing
 * important was (the PII is).
 */
export interface EraseCustomerResult {
  ok: true;
  customerId: string;
  erasedAt: string;
  fieldsCleared: string[];
  retainedTables: string[];
}

export interface PreAssessment {
  id: string;
  /** "PA-2026-000123". */
  number: string;
  source: PreAssessmentSource;

  customerId: string | null;
  prospectName: string | null;
  prospectPhone: string | null;
  prospectEmail: string | null;

  productCode: string;
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  monthlyIncome: number;
  applicantAge: number;

  verdict: PreAssessmentVerdict;
  reason: string;
  matchedRuleId: string | null;
  /** Snapshotted — the rule itself may since have been edited or deleted. */
  matchedRuleName: string | null;
  /**
   * Which revision of that rule fired. The name alone does not settle
   * what was required — rules get retuned, and a rule reading "A-tier
   * fast-track" today may demand a score this applicant never had. Null
   * on assessments run before rules were versioned.
   */
  matchedRuleVersion: number | null;

  /**
   * How much the engine actually knew. `FULL` means score, AML and KYC
   * came off a real Customer row. `INDICATIVE` means the subject is a
   * prospect and those inputs were absent, so the verdict is a guide, not
   * a decision.
   */
  basis: "FULL" | "INDICATIVE";

  /** Null on prospect rows — no customer, no gates to check. */
  gates: LoanDryRunResult["gates"] | null;
  anomalies: AnomalyFlag[];
  context: {
    principal: number;
    termMonths: number;
    annualInterestRate: number;
    productCode: string;
    creditScore: number | null;
    tier: CreditTier | null;
    monthlyIncome: number;
    existingActiveLoans: number;
  };

  /** Set once this assessment turned into a real application. */
  loanId: string | null;
  convertedAt: string | null;
  createdAt: string;
  createdById: string | null;
  /** Joined for the staff list view; absent on prospect rows. */
  customer?: {
    id: string;
    number: string;
    firstName: string;
    lastName: string;
  } | null;
}

/**
 * In-progress loan-wizard state. Persisted via /loans/drafts so an
 * officer can pause + resume across sessions / devices. The `formState`
 * field is opaque to the API — the wizard owns its shape — but the
 * lifted fields (`customerId`, `productCode`, `lastStep`) power the
 * drafts list rendering.
 */
export interface LoanDraft {
  id: string;
  authorId: string;
  customerId: string | null;
  productCode: string | null;
  lastStep: number;
  /** Wizard's serialized form state. Type is owned by the web app. */
  formState: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LoanDraftCreateInput {
  customerId?: string | null;
  productCode?: string | null;
  lastStep?: number;
  formState: unknown;
}

export type LoanDraftUpdateInput = Partial<LoanDraftCreateInput>;

/**
 * Body of POST /loans/:id/selfie-match. Client-side computed using
 * face-api.js (browser-local — no image data leaves the user's machine).
 * The API persists the score onto the LoanApplication + writes an audit
 * log row if the match failed (`passed === false`).
 */
export interface SelfieMatchInput {
  /** Normalized similarity 0..1, higher = better. score < 0.55 = flag. */
  score: number;
  /** Raw Euclidean distance from face-api.js (lower = better). */
  distance: number;
  /** True when score ≥ 0.55, i.e. likely same person. */
  passed: boolean;
  /** Model identifier for reproducibility (e.g. "face-api/1.7.13/ssd"). */
  model: string;
}

/**
 * Anomaly signal returned alongside the dry-run verdict (and persisted
 * in the audit log when one fires on actual /apply). `code` is stable
 * across releases — UI and analytics depend on it. `message` is free-form
 * human copy.
 */
export interface AnomalyFlag {
  code:
    | "PRINCIPAL_OUTLIER"
    | "TERM_OUTLIER"
    | "RATE_OUTLIER"
    | "APPLICANT_VELOCITY"
    | "PRINCIPAL_TO_INCOME"
    | "INSUFFICIENT_BASELINE";
  severity: "low" | "medium" | "high";
  message: string;
  /** Z-score for outlier flags. Null for non-stats checks. */
  zScore: number | null;
  /** The observed value being flagged. */
  observed: number | null;
  /** The mean of the historical baseline (for outlier flags). */
  baseline: number | null;
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export interface AuditEventRow {
  id: string;
  /** Coarse action label, e.g. "LOAN_DECIDE", "JOURNAL_REVERSE". */
  action: string;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AuditEventFilter extends PageQuery {
  actorId?: string;
  /** Free text over the actor's name and email. Tokenized server-side. */
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  /**
   * "The newest N", for callers that want a slice rather than a page.
   * Ignored when `page` is set — a paged caller has already said how
   * many rows it wants.
   */
  take?: number;
}

/** The collector working an account, as the queue reports them. */
export interface QueueAssignee {
  collectorId: string;
  collectorName: string;
  assignedAt: string;
  note: string | null;
}

export interface OverdueRow {
  id: string;
  number: string;
  productCode: string;
  status: LoanStatus;
  customerId: string;
  customerName: string;
  /**
   * Borrower's area, for routing accounts to the collector who covers
   * it. City is required on Customer; province isn't.
   */
  customerCity: string;
  customerProvince: string | null;
  principal: string | number;
  daysOverdue: number;
  outstanding: number;
  overdueCount: number;
  /** Null when the account is still in the unassigned pool. */
  assignee: QueueAssignee | null;
  /**
   * §29 collection priority — the score the queue is now ordered by,
   * with the per-factor breakdown that justifies the position.
   *
   * Rows arrive sorted by `priority.score` descending, NOT by
   * `daysOverdue`. Both numbers are returned, so a client that wants
   * the old ordering can still produce it.
   */
  priority: CollectionPriority;
}

/**
 * One page of the overdue queue.
 *
 * `rows` is a WINDOW onto the queue's global ranking, not a re-ranked
 * page: every eligible account is scored and ordered against every
 * other one server-side before the window is cut, so row 1 of page 1 is
 * the highest-priority account in the whole book and page 2 continues
 * that same order. `total` is the size of the filtered queue.
 */
export interface OverdueQueuePage extends Paginated<OverdueRow> {
  /**
   * Distinct borrower areas across the caller's whole scope — the
   * options the area filter should offer. Derived server-side from the
   * unfiltered scope, so the control neither shrinks to the current
   * page nor collapses to the value already selected.
   */
  areas: {
    provinces: string[];
    cities: string[];
  };
}

/** One weighted factor's contribution to a collection priority score. */
export interface CollectionPriorityFactor {
  factorId: string;
  label: string;
  /** Share of the total score this factor can contribute (0..1). */
  weight: number;
  /** How strongly it fired, 0..1. */
  strength: number;
  /** Its actual contribution to the score. */
  points: number;
  /** Plain-language reason — what makes the ordering arguable. */
  source: string;
}

/**
 * The §29 score and what to do about it.
 *
 * The weights behind `score` are an uncalibrated starting policy, not a
 * fitted model, and two of §29's eight named inputs have no source in
 * this schema — both facts are carried in `missingFactors` rather than
 * left for the reader to discover.
 */
export interface CollectionPriority {
  /** 0–100. Higher means work it sooner. */
  score: number;
  band: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  /** §28 aging band this account falls in. */
  agingBucket: string;
  factors: CollectionPriorityFactor[];
  action:
    | "AWAIT_PROMISE"
    | "SEND_REMINDER"
    | "CALL_BORROWER"
    | "FIELD_VISIT"
    | "ISSUE_DEMAND_LETTER"
    | "FINAL_DEMAND"
    | "INITIATE_REPOSSESSION"
    | "ESCALATE_LEGAL"
    | "MONITOR_RECOVERY_ONLY";
  actionReason: string;
  channel: "SMS" | "EMAIL" | "PHONE" | "FIELD" | "LETTER";
  channelReason: string;
  /** ISO date — serialized over the wire. */
  nextFollowUpDate: string;
  followUpReason: string;
  /** True when the loan is terminal and pushed down the queue. */
  suppressed: boolean;
  /** §29 inputs with no source in this schema. */
  missingFactors: Array<{ requirement: string; reason: string }>;
}

/** Result of POST /collections/assignees/bulk. */
export interface BulkAssignResult {
  /** Accounts now owned by the collector (upserts — includes moves). */
  assigned: number;
  /** Requested ids that matched no loan; nothing was written for them. */
  missing: string[];
}

/**
 * Whose accounts to list.
 *   all         every delinquent account — the shared worklist
 *   mine        the caller's own; resolved server-side from the token
 *   unassigned  the pool a supervisor hands out from
 */
export type QueueScope = "all" | "mine" | "unassigned";

export interface CollectorWorkload {
  collectorId: string;
  collectorName: string;
  accounts: number;
}

export interface AssignableCollector {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

// ─── Approval chain (per-product workflow) ──────────────────────────────

export type LoanApprovalStatus =
  "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED";

export interface LoanApprovalStep {
  id: string;
  productCode: string;
  order: number;
  label: string;
  requiredPermission: string;
  optional: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoanApproval {
  id: string;
  loanId: string;
  stepOrder: number;
  stepLabel: string;
  requiredPermission: string;
  status: LoanApprovalStatus;
  notes: string | null;
  approverId: string | null;
  approvedAt: string | null;
  signedUnderDelegationId: string | null;
  /** Joined for display — present when the row has been acted on. */
  approver?: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoanApprovalStepInput {
  order: number;
  label: string;
  requiredPermission: string;
  optional?: boolean;
}

export interface LoanApprovalActionResult {
  approval: LoanApproval;
  isFinal: boolean;
  nextStep: number | null;
}

// ─── Customer ledger (unified statement of account) ─────────────────────

export type CustomerLedgerEntryKind =
  | "LOAN_DISBURSEMENT"
  | "LOAN_PAYMENT"
  | "PENALTY_WAIVER"
  | "CONTRIBUTION"
  | "SAVINGS_DEPOSIT"
  | "SAVINGS_WITHDRAWAL";

export type CustomerLedgerDirection = "INFLOW" | "OUTFLOW";

export type CustomerLedgerScope = "ALL" | "LOANS" | "COOP";

export interface CustomerLedgerEntry {
  date: string;
  kind: CustomerLedgerEntryKind;
  description: string;
  /** Always positive — `direction` tells you which side of the ledger. */
  amount: number;
  direction: CustomerLedgerDirection;
  loanNumber: string | null;
  ref?: string | null;
  notes?: string | null;
  /**
   * What the member owed after this entry — principal plus scheduled
   * interest on live loans, less repayments and waivers.
   */
  owedAfter: number;
  /**
   * What the coop held for the member after this entry — savings plus
   * capital build-up.
   *
   * Deliberately separate from `owedAfter` and never to be added to it.
   * The single figure these replaced summed a debt being settled with
   * savings the member did not have, so a borrower's interest payments
   * came out looking like a deposit.
   */
  heldAfter: number;
}

export interface CustomerLedgerSummary {
  totalDisbursed: number;
  totalRepaid: number;
  totalPenaltyWaived: number;
  outstandingPrincipal: number;
  savingsBalance: number;
  savingsDeposits: number;
  savingsWithdrawals: number;
  contributionsTotal: number;
  capitalBuildUp: number;
  mortuaryFund: number;
  emergencyFund: number;
  /** Owed to the coop: live-loan obligation less repayments and waivers. */
  amountOwed: number;
  /**
   * Held by the coop for the member: savings + capital build-up.
   * Excludes mortuary and emergency, which are pooled and spent on
   * claims rather than returned. Never add this to `amountOwed`.
   */
  amountHeld: number;
}

export interface CustomerLedger {
  customer: {
    id: string;
    number: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    email: string | null;
    phone: string;
  };
  asOf: string;
  range: { from: string | null; to: string | null };
  scope: CustomerLedgerScope;
  summary: CustomerLedgerSummary;
  entries: CustomerLedgerEntry[];
}
