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

export { createPrismaClient } from "./client.js";
export { fastifyPrisma } from "./plugin.js";
export {
  isUuid,
  idOrNumberWhere,
  nextCustomerNumber,
  nextKycNumber,
  nextPaymentIntentNumber,
  nextVehicleNumber,
  nextPropertyNumber,
} from "./lib/reference-numbers.js";
export * from "./repositories/customer.repository.js";
export * from "./repositories/kyc.repository.js";
export * from "./repositories/credit-score.repository.js";
export * from "./repositories/survey.repository.js";
export * from "./repositories/loan.repository.js";
export * from "./repositories/loan-draft.repository.js";
export * from "./repositories/loan-product.repository.js";
export * from "./repositories/accounting.repository.js";
export * from "./repositories/collections.repository.js";
export * from "./repositories/payment-intent.repository.js";
export * from "./repositories/audit-log.repository.js";
export * from "./repositories/job.repository.js";
export * from "./repositories/notification.repository.js";
export * from "./repositories/screening.repository.js";
export * from "./repositories/co-maker.repository.js";
export * from "./repositories/decision-rule.repository.js";
export * from "./repositories/rbac.repository.js";
export * from "./repositories/delegation.repository.js";
export * from "./repositories/bank-reconciliation.repository.js";
export * from "./repositories/ecl.repository.js";
export * from "./repositories/cooperative.repository.js";
export * from "./repositories/annual-document.repository.js";
export * from "./repositories/demand-letter.repository.js";
export * from "./repositories/repossession.repository.js";
export * from "./repositories/dorsi.repository.js";
export * from "./repositories/lease.repository.js";
export * from "./repositories/loan-approval.repository.js";
export * from "./repositories/customer-ledger.repository.js";
