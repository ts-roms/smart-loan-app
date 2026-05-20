/**
 * Permission catalog — the single source of truth for what fine-grained
 * actions exist in the system. The keys here are referenced from code
 * (`app.requirePermission('loans.approve')`) and from the DB seed (which
 * upserts a row per key).
 *
 * Adding a permission:
 *   1. Add it below in the right category.
 *   2. Add it to whichever canonical roles should grant it (DEFAULT_ROLES).
 *   3. Use `app.requirePermission('...')` in the route.
 *   4. Re-run `pnpm db:seed` (idempotent; upserts).
 */

export interface PermissionDefinition {
  key: string;
  label: string;
  description?: string;
  category: PermissionCategory;
}

export type PermissionCategory =
  | 'Loans'
  | 'KYC'
  | 'Customers'
  | 'Accounting'
  | 'Collections'
  | 'Payments'
  | 'Products'
  | 'Screening'
  | 'Documents'
  | 'Operations'
  | 'Admin'
  | 'Portal'
  | 'Cooperative';

export const PERMISSIONS: ReadonlyArray<PermissionDefinition> = [
  // Loans
  { key: 'loans.read',          label: 'View loans',           category: 'Loans' },
  { key: 'loans.apply',         label: 'Submit applications',  category: 'Loans' },
  { key: 'loans.decide',        label: 'Approve / reject',     category: 'Loans' },
  { key: 'loans.disburse',      label: 'Disburse funds',       category: 'Loans' },
  { key: 'loans.restructure',   label: 'Restructure',          category: 'Loans' },
  { key: 'loans.write_off',     label: 'Write off',            category: 'Loans' },
  { key: 'loans.close_early',   label: 'Close early',          category: 'Loans' },
  { key: 'loans.sign_officer',  label: 'Sign as lender',       category: 'Loans' },

  // KYC
  { key: 'kyc.read',            label: 'View KYC',             category: 'KYC' },
  { key: 'kyc.submit',          label: 'Submit documents',     category: 'KYC' },
  { key: 'kyc.decide',          label: 'Verify / reject',      category: 'KYC' },

  // Customers
  { key: 'customers.read',      label: 'View customers',       category: 'Customers' },
  { key: 'customers.write',     label: 'Create / edit',        category: 'Customers' },

  // Accounting
  { key: 'accounting.read',         label: 'View ledger',              category: 'Accounting' },
  { key: 'accounting.post_journal', label: 'Post manual journal',      category: 'Accounting' },
  { key: 'accounting.reverse',      label: 'Reverse entries',          category: 'Accounting' },
  { key: 'accounting.close_period', label: 'Close / reopen periods',   category: 'Accounting' },
  { key: 'accounting.accrue',       label: 'Run accrual jobs',         category: 'Accounting' },
  { key: 'accounting.accounts',     label: 'Manage chart of accounts', category: 'Accounting' },

  // Collections
  { key: 'collections.read',    label: 'View collections',     category: 'Collections' },
  { key: 'collections.note',    label: 'Add notes / PTPs',     category: 'Collections' },
  { key: 'collections.accrue',  label: 'Run late-fee accrual', category: 'Collections' },

  // Payments
  { key: 'payments.record',     label: 'Record single payment', category: 'Payments' },
  { key: 'payments.bulk',       label: 'Bulk payment import',   category: 'Payments' },
  { key: 'payments.intents',    label: 'Create payment intents', category: 'Payments' },

  // Products
  { key: 'products.read',       label: 'View loan products',    category: 'Products' },
  { key: 'products.write',      label: 'Create / edit / delete', category: 'Products' },

  // Screening
  { key: 'screening.read',      label: 'View AML screenings',  category: 'Screening' },
  { key: 'screening.run',       label: 'Re-run screening',     category: 'Screening' },
  { key: 'screening.override',  label: 'Override AML match',   category: 'Screening' },
  { key: 'screening.watchlist', label: 'Manage watchlist',     category: 'Screening' },

  // Documents
  { key: 'documents.download',  label: 'Download PDFs',        category: 'Documents' },

  // Operations
  { key: 'jobs.read',           label: 'View scheduled jobs',  category: 'Operations' },
  { key: 'jobs.run',            label: 'Manually trigger',     category: 'Operations' },
  { key: 'jobs.configure',      label: 'Edit cron / pause',    category: 'Operations' },
  { key: 'notifications.read',  label: 'View notifications',   category: 'Operations' },
  { key: 'notifications.test',  label: 'Send test notifications', category: 'Operations' },

  // Admin
  { key: 'admin.users',         label: 'Manage users',         category: 'Admin' },
  { key: 'admin.roles',         label: 'Manage roles + permissions', category: 'Admin' },
  { key: 'admin.decision_rules', label: 'Edit decision rules', category: 'Admin' },
  { key: 'admin.audit_log',     label: 'View audit log',       category: 'Admin' },

  // Portal (customer-facing)
  { key: 'portal.self',         label: 'Borrower self-service', category: 'Portal' },

  // Cooperative modules (Contributions, Savings, Funds, Expenses, Other Income, Big Brother)
  { key: 'coop.read',           label: 'View cooperative records', category: 'Cooperative' },
  { key: 'coop.contribute',     label: 'Record contributions',     category: 'Cooperative' },
  { key: 'coop.savings',        label: 'Record member savings',    category: 'Cooperative' },
  { key: 'coop.funds',          label: 'Record fund in/out',       category: 'Cooperative' },
  { key: 'coop.expense',        label: 'Record expenses',          category: 'Cooperative' },
  { key: 'coop.income',         label: 'Record other income',      category: 'Cooperative' },
  { key: 'coop.big_brother',    label: 'Manage Big Brother capital', category: 'Cooperative' },
];

/**
 * Convenience map: category → permission keys. Drives the role editor UI.
 */
export const PERMISSIONS_BY_CATEGORY: Record<PermissionCategory, PermissionDefinition[]> =
  PERMISSIONS.reduce(
    (acc, p) => {
      (acc[p.category] = acc[p.category] ?? []).push(p);
      return acc;
    },
    {} as Record<PermissionCategory, PermissionDefinition[]>,
  );

/** All permission keys as a Set, for runtime validation. */
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

// ─── Default roles ─────────────────────────────────────────────────────────

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  /** True for the four canonical roles; they can't be deleted via the API. */
  system: boolean;
  permissions: string[];
}

const ALL_PERMS = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLES: ReadonlyArray<RoleDefinition> = [
  {
    key: 'ADMIN',
    name: 'Admin',
    description: 'Full access to the platform.',
    system: true,
    permissions: ALL_PERMS,
  },
  {
    key: 'LOAN_OFFICER',
    name: 'Loan Officer',
    description: 'Underwrites loans, runs KYC, manages collections.',
    system: true,
    permissions: [
      'loans.read', 'loans.apply', 'loans.decide', 'loans.disburse',
      'loans.restructure', 'loans.close_early', 'loans.sign_officer',
      'kyc.read', 'kyc.submit', 'kyc.decide',
      'customers.read', 'customers.write',
      'collections.read', 'collections.note',
      'screening.read', 'screening.run',
      'documents.download',
      'products.read',
      'accounting.read',
      'notifications.read',
    ],
  },
  {
    key: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Records payments, posts journal entries, reconciles books.',
    system: true,
    permissions: [
      'loans.read',
      'payments.record', 'payments.bulk', 'payments.intents',
      'accounting.read', 'accounting.post_journal', 'accounting.reverse',
      'accounting.close_period', 'accounting.accrue', 'accounting.accounts',
      'collections.read', 'collections.accrue',
      'customers.read',
      'documents.download',
      'products.read',
      'jobs.read', 'jobs.run',
      'notifications.read',
      // Coop cash-handling is accountant territory by default.
      'coop.read', 'coop.contribute', 'coop.savings',
      'coop.funds', 'coop.expense', 'coop.income', 'coop.big_brother',
    ],
  },
  {
    key: 'CUSTOMER',
    name: 'Customer',
    description: 'Self-serve borrower account.',
    system: true,
    permissions: ['portal.self'],
  },
];

/** Used by the seed script + by the runtime when reconciling on boot. */
export const DEFAULT_ROLE_BY_KEY: Record<string, RoleDefinition> = Object.fromEntries(
  DEFAULT_ROLES.map((r) => [r.key, r]),
);
