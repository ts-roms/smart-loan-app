export {
  type Customer,
  type CreditScore,
  type SurveyResponse,
  type LoanApplication,
  type LoanDraft,
  type LoanSchedule,
  type LoanPayment,
  type KycSubmission,
  type User,
  type Account,
  type AccountingPeriod,
  type AmlScreening,
  type AmlWatchlistEntry,
  type AnnualDocument,
  type AuditEvent,
  type DemandLetter,
  type RepossessionCase,
  type DorsiRecord,
  type DorsiBoardApproval,
  type SystemConfig,
  type LeaseAgreement,
  type CoMaker,
  type CollectionNote,
  type DecisionRule,
  type Delegation,
  type JobRun,
  type Notification,
  type Permission,
  type Role,
  type RolePermission,
  type ScheduledJob,
  type UserRoleAssignment,
  type JournalEntry,
  type JournalLine,
  type LoanProduct,
  type PaymentIntent,
  type PromiseToPay,
  type Vehicle,
  type Property,
  type PrismaClient,
  type BankStatement,
  type BankStatementLine,
  type BigBrotherAccount,
  type Contribution,
  type EclRun,
  type Expense,
  type FundTransaction,
  type FundWithdrawal,
  type OtherIncome,
  type RefreshToken,
  type SavingsTransaction,
  AccountType,
  AnnualDocumentStatus,
  AnnualDocumentType,
  DemandLetterStage,
  DemandLetterStatus,
  RepossessionStatus,
  DorsiCategory,
  LeaseStatus,
  LeaseTitleHolder,
  BankStatementStatus,
  CollateralKind,
  EclStage,
  SavingsTxnKind,
  CollateralStatus,
  CollectionNoteType,
  CreditTier,
  EmploymentStatus,
  GovernmentIdType,
  JournalSource,
  KycDocumentType,
  KycStatus,
  KycSubmissionStatus,
  AmlStatus,
  CoMakerRole,
  InterestMethod,
  JobStatus,
  LoanStatus,
  RuleAction,
  NormalBalance,
  NotificationChannel,
  NotificationEvent,
  NotificationStatus,
  PaymentFrequency,
  PaymentIntentStatus,
  PaymentProvider as PaymentProviderEnum,
  PeriodStatus,
  PromiseStatus,
  UserRole,
} from "@prisma/client";

export { createPrismaClient } from "./client";
export { fastifyPrisma } from "./plugin";
export {
  isUuid,
  idOrNumberWhere,
  nextCustomerNumber,
  nextKycNumber,
  nextPaymentIntentNumber,
  nextVehicleNumber,
  nextPropertyNumber,
} from "./lib/reference-numbers";
export * from "./repositories/customer.repository";
export * from "./repositories/kyc.repository";
export * from "./repositories/credit-score.repository";
export * from "./repositories/survey.repository";
export * from "./repositories/loan.repository";
export * from "./repositories/loan-draft.repository";
export * from "./repositories/loan-product.repository";
export * from "./repositories/accounting.repository";
export * from "./repositories/collections.repository";
export * from "./repositories/payment-intent.repository";
export * from "./repositories/audit-log.repository";
export * from "./repositories/job.repository";
export * from "./repositories/notification.repository";
export * from "./repositories/screening.repository";
export * from "./repositories/co-maker.repository";
export * from "./repositories/decision-rule.repository";
export * from "./repositories/rbac.repository";
export * from "./repositories/delegation.repository";
export * from "./repositories/bank-reconciliation.repository";
export * from "./repositories/ecl.repository";
export * from "./repositories/cooperative.repository";
export * from "./repositories/annual-document.repository";
export * from "./repositories/demand-letter.repository";
export * from "./repositories/repossession.repository";
export * from "./repositories/dorsi.repository";
export * from "./repositories/lease.repository";
export * from "./repositories/loan-approval.repository";
export * from "./repositories/customer-ledger.repository";
