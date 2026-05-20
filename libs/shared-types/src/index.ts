// User + auth
/**
 * Canonical user roles. The string union is the single source of truth —
 * components needing the set of roles should import `USER_ROLES` rather
 * than re-typing the literals. Used by RBAC gates, nav role filters, etc.
 */
export const USER_ROLES = ['ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT', 'CUSTOMER'] as const;
export type UserRole = (typeof USER_ROLES)[number];
/** Staff (non-customer) — the four primary console personas combined. */
export const STAFF_ROLES = ['ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT'] as const satisfies ReadonlyArray<UserRole>;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Customer
export type GovernmentIdType =
  | 'PASSPORT' | 'DRIVERS_LICENSE' | 'NATIONAL_ID' | 'SSS' | 'TIN' | 'OTHER';
export type EmploymentStatus =
  | 'EMPLOYED' | 'SELF_EMPLOYED' | 'UNEMPLOYED' | 'RETIRED' | 'STUDENT';
export type KycStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface Customer {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string;
  phone: string;
  email: string | null;
  address: string;
  city: string;
  province: string | null;
  postalCode: string | null;
  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;
  employmentStatus: EmploymentStatus;
  employerName: string | null;
  jobTitle: string | null;
  monthlyIncome: string | number;
  yearsAtCurrentJob: string | number | null;
  kycStatus: KycStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerCreateInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  dateOfBirth: string;
  phone: string;
  email?: string;
  address: string;
  city: string;
  province?: string;
  postalCode?: string;
  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;
  employmentStatus: EmploymentStatus;
  employerName?: string;
  jobTitle?: string;
  monthlyIncome: number;
  yearsAtCurrentJob?: number;
}

// KYC
export type KycDocumentType =
  | 'ID_FRONT' | 'ID_BACK' | 'PROOF_OF_INCOME' | 'PROOF_OF_ADDRESS' | 'SELFIE'
  | 'VEHICLE_OR' | 'VEHICLE_CR' | 'PROPERTY_TITLE' | 'TAX_DECLARATION';
export type KycSubmissionStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface KycSubmission {
  id: string;
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
export type CreditTier = 'A' | 'B' | 'C' | 'D' | 'F';

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
  computedAt: string;
}

export type SurveyAnswer = string | number | boolean;

export type SurveyQuestion =
  | {
      kind: 'choice';
      id: string;
      label: string;
      help?: string;
      options: Array<{ label: string; value: string; weight: number }>;
      factorId: string;
    }
  | {
      kind: 'number';
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
      kind: 'boolean';
      id: string;
      label: string;
      help?: string;
      weightWhenTrue: number;
      factorId: string;
    };

// Loans
export type LoanStatus =
  | 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED'
  | 'DISBURSED' | 'ACTIVE' | 'CLOSED' | 'DEFAULTED' | 'CANCELLED';

/**
 * Product types are a string code now — the catalog is dynamic and admins
 * can add new products at runtime. The classic four still ship as defaults.
 */
export type LoanType = string;
export type CollateralKind = 'NONE' | 'VEHICLE' | 'PROPERTY';
export type CollateralStatus = 'PROPOSED' | 'VERIFIED' | 'RELEASED' | 'SEIZED';
export type InterestMethod = 'DECLINING' | 'FLAT';
export type PaymentFrequency = 'MONTHLY' | 'BIWEEKLY' | 'WEEKLY';

export interface LoanProduct {
  id: string;
  code: string;
  name: string;
  description: string | null;
  collateralKind: CollateralKind;
  requiredKycDocs: KycDocumentType[];

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

export type LoanProductUpdateInput = Partial<Omit<LoanProductCreateInput, 'code'>>;

export interface VehicleInput {
  kind: 'CAR' | 'MOTORCYCLE';
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

export interface Vehicle extends Omit<VehicleInput, 'appraisedValue'> {
  id: string;
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

export interface Property extends Omit<PropertyInput, 'appraisedValue' | 'areaSqm'> {
  id: string;
  areaSqm: string | number | null;
  appraisedValue: string | number;
  status: CollateralStatus;
  createdAt: string;
  updatedAt: string;
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
}

export interface UploadResult {
  url: string;
  filename: string;
  mimetype: string;
}

// Jobs
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

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
export type NotificationChannel = 'EMAIL' | 'SMS' | 'IN_APP';
export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED';
export type NotificationEvent =
  | 'LOAN_APPROVED'
  | 'LOAN_REJECTED'
  | 'LOAN_DISBURSED'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_DUE_SOON'
  | 'PAYMENT_OVERDUE'
  | 'PROMISE_TO_PAY'
  | 'WELCOME'
  | 'TEST';

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
  customerId: string | null;
  createdAt: string;
  sentAt: string | null;
}

// AML screening
export type AmlStatus = 'PENDING' | 'CLEAR' | 'MATCH' | 'REVIEW' | 'OVERRIDDEN';

export interface AmlScreening {
  id: string;
  customerId: string;
  status: AmlStatus;
  provider: string;
  providerRef: string | null;
  matches: Array<{ list: string; matchedName: string; score: number; reason?: string }> | null;
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
export type CoMakerRole = 'CO_BORROWER' | 'GUARANTOR' | 'CO_MAKER';

export interface CoMaker {
  id: string;
  loanId: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface CoMakerInput {
  fullName: string;
  role?: CoMakerRole;
  relationship?: string;
  phone: string;
  email?: string;
  address?: string;
  governmentIdType?: GovernmentIdType;
  governmentIdNumber?: string;
  monthlyIncome?: number;
  signedAgreementUrl?: string;
  notes?: string;
}

// Decision rules
export type RuleAction = 'AUTO_APPROVE' | 'AUTO_REJECT' | 'MANUAL_REVIEW';
export type DecisioningOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not_in';

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
  createdAt: string;
  updatedAt: string;
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
export interface Permission {
  id: string;
  key: string;
  label: string;
  description: string | null;
  category: string;
  system: boolean;
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
  _count?: { users: number };
}

export interface RoleCreateInput {
  key: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface RoleUpdateInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

export interface UserWithRoles {
  id: string;
  email: string;
  name: string;
  primaryRole: UserRole;
  active: boolean;
  createdAt: string;
  roles: Array<{ key: string; name: string; system: boolean }>;
}

export interface MePermissions {
  permissions: string[];
  roles: Array<{ key: string; name: string; system: boolean }>;
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
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type JournalSource =
  | 'MANUAL'
  | 'LOAN_DISBURSEMENT'
  | 'LOAN_PAYMENT'
  | 'REVERSAL'
  | 'ADJUSTMENT';

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
  income: { rows: Array<{ code: string; name: string; amount: number }>; total: number };
  expense: { rows: Array<{ code: string; name: string; amount: number }>; total: number };
  netIncome: number;
}

export interface BalanceSheetReport {
  asOf: string;
  assets: { rows: Array<{ code: string; name: string; amount: number }>; total: number };
  liabilities: { rows: Array<{ code: string; name: string; amount: number }>; total: number };
  equity: { rows: Array<{ code: string; name: string; amount: number }>; total: number };
  retainedEarnings: number;
  totalLiabilitiesAndEquity: number;
  inBalance: boolean;
}

export type AgingBucket = 'CURRENT' | 'D_1_30' | 'D_31_60' | 'D_61_90' | 'D_90_PLUS';

export interface AgingRow {
  loanId: string;
  loanNumber: string;
  customerName: string;
  installmentsOverdue: number;
  outstandingBalance: number;
  bucket: AgingBucket;
  daysOverdue: number;
}

export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  totals: Record<AgingBucket, number>;
  totalOutstanding: number;
}

export type PeriodStatus = 'OPEN' | 'CLOSED';

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
export type CollectionNoteType = 'CALL' | 'SMS' | 'EMAIL' | 'VISIT' | 'OTHER';
export type PromiseStatus = 'PROMISED' | 'HONORED' | 'BROKEN' | 'CANCELLED';

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
export type PaymentProviderName = 'MOCK' | 'GCASH' | 'MAYA';
export type PaymentIntentStatus =
  | 'CREATED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface PaymentIntent {
  id: string;
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

export interface AuditEventFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  take?: number;
}

export interface OverdueRow {
  id: string;
  number: string;
  productCode: string;
  status: LoanStatus;
  customerId: string;
  customerName: string;
  principal: string | number;
  daysOverdue: number;
  outstanding: number;
  overdueCount: number;
}
