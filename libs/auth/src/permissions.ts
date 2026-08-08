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
  | "Loans"
  | "Agents"
  | "KYC"
  | "Customers"
  | "Accounting"
  | "Collections"
  | "Payments"
  | "Products"
  | "Screening"
  | "Documents"
  | "Operations"
  | "Admin"
  | "Portal"
  | "Cooperative";

export const PERMISSIONS: ReadonlyArray<PermissionDefinition> = [
  // Loans
  { key: "loans.read", label: "View loans", category: "Loans" },
  { key: "loans.apply", label: "Submit applications", category: "Loans" },
  // Pre-assessment: run the decisioning rules before an application
  // exists. Its own prefix (like repossession.* and lease.*) rather than
  // a loans.* key, because the subject may be a walk-in prospect with no
  // Customer row — it is upstream of the loan pipeline, not part of it.
  //
  // Split read/run so a branch receptionist can quote a figure without
  // also gaining the history of everyone else's checks.
  {
    key: "pre_assessment.run",
    label: "Run a pre-assessment",
    category: "Loans",
  },
  {
    key: "pre_assessment.read",
    label: "View pre-assessment history",
    category: "Loans",
  },
  {
    key: "loans.decide",
    label: "Approve / reject (legacy single-decide)",
    category: "Loans",
  },
  // Approval-chain permissions. Steps on LoanProduct.approvalSteps reference
  // these keys; whoever holds the key (directly or via Delegation) can
  // approve that step. Admin-managed chains can pick any combination.
  {
    key: "loans.approve.officer",
    label: "Approve loan: Officer step",
    category: "Loans",
  },
  {
    key: "loans.approve.bm",
    label: "Approve loan: Branch Manager step",
    category: "Loans",
  },
  {
    key: "loans.approve.committee",
    label: "Approve loan: Credit Committee step",
    category: "Loans",
  },
  {
    key: "loans.approval.chain.manage",
    label: "Configure per-product approval chains",
    category: "Loans",
  },
  { key: "loans.disburse", label: "Disburse funds", category: "Loans" },
  { key: "loans.restructure", label: "Restructure", category: "Loans" },
  { key: "loans.write_off", label: "Write off", category: "Loans" },
  { key: "loans.waive_penalty", label: "Waive penalties", category: "Loans" },
  { key: "loans.docs_renew", label: "Manage annual docs", category: "Loans" },
  // Repossession workflow — split per approval step so RBAC
  // can route the chain to specific roles (BM / Credit Head / Legal).
  {
    key: "repossession.identify",
    label: "Identify repossession case",
    category: "Loans",
  },
  {
    key: "repossession.bm_approve",
    label: "Branch Manager approval",
    category: "Loans",
  },
  {
    key: "repossession.credit_approve",
    label: "Credit Head approval",
    category: "Loans",
  },
  {
    key: "repossession.legal_approve",
    label: "Legal Department approval",
    category: "Loans",
  },
  {
    key: "repossession.assign_agent",
    label: "Assign repossession agent",
    category: "Loans",
  },
  {
    key: "repossession.recover",
    label: "Record vehicle recovery",
    category: "Loans",
  },
  {
    key: "repossession.auction",
    label: "Auction settlement",
    category: "Loans",
  },
  // Lease-to-Own.
  { key: "lease.read", label: "View lease agreements", category: "Loans" },
  { key: "lease.buyout", label: "Process residual buyout", category: "Loans" },
  {
    key: "lease.pull_out",
    label: "Pull out non-employee leased vehicle",
    category: "Loans",
  },
  {
    key: "lease.close",
    label: "Close lease (return / extend)",
    category: "Loans",
  },
  { key: "loans.close_early", label: "Close early", category: "Loans" },
  { key: "loans.sign_officer", label: "Sign as lender", category: "Loans" },

  // Agents
  //
  // Four keys rather than the usual read/write pair, because the money
  // and the directory are different privileges.
  {
    key: "agents.read",
    label: "View agents",
    category: "Agents",
    description: "See the agent directory and any agent's book of loans.",
  },
  {
    key: "agents.manage",
    label: "Create / edit agents",
    category: "Agents",
    description:
      "Add agents, deactivate them, and set a per-agent commission rate that overrides the product default.",
  },
  {
    key: "agents.assign",
    label: "Assign to loans",
    category: "Agents",
    description:
      "Credit an application to an agent, or move it to a different one. Held apart from agents.manage so an officer can attribute a loan without being able to set what anyone is paid for it.",
  },
  {
    key: "agents.payout",
    category: "Agents",
    label: "Pay commissions",
    description:
      "Run and void agent payouts. Cash leaving the till, so it sits with the accountant rather than with whoever set the rate or credited the loan — the person who decides what an agent earns should not also be the one who pays it.",
  },
  {
    key: "agents.self",
    label: "View own book",
    category: "Agents",
    description:
      "An agent's view of their own assisted loans and commission. Scoped to the signed-in agent by the endpoint, not by this key — it grants nothing about anyone else.",
  },

  // KYC
  { key: "kyc.read", label: "View KYC", category: "KYC" },
  { key: "kyc.submit", label: "Submit documents", category: "KYC" },
  { key: "kyc.decide", label: "Verify / reject", category: "KYC" },

  // Customers
  { key: "customers.read", label: "View customers", category: "Customers" },
  { key: "customers.write", label: "Create / edit", category: "Customers" },
  /**
   * Archiving is its own key, not part of customers.write. It is
   * reversible and destroys nothing, but it removes someone from every
   * picker and blocks new lending to them — "can fix a typo" and "can
   * take a member off the books" are different powers, and a clerk
   * needs only the first.
   */
  {
    key: "customers.archive",
    label: "Archive / restore customers",
    category: "Customers",
  },

  // Accounting
  { key: "accounting.read", label: "View ledger", category: "Accounting" },
  {
    key: "accounting.post_journal",
    label: "Post manual journal",
    category: "Accounting",
  },
  {
    key: "accounting.reverse",
    label: "Reverse entries",
    category: "Accounting",
  },
  {
    key: "accounting.close_period",
    label: "Close / reopen periods",
    category: "Accounting",
  },
  {
    key: "accounting.accrue",
    label: "Run accrual jobs",
    category: "Accounting",
  },
  {
    key: "accounting.accounts",
    label: "Manage chart of accounts",
    category: "Accounting",
  },

  // Collections
  {
    key: "collections.read",
    label: "View collections",
    category: "Collections",
  },
  {
    key: "collections.note",
    label: "Add notes / PTPs",
    category: "Collections",
  },
  {
    key: "collections.accrue",
    label: "Run late-fee accrual",
    category: "Collections",
  },
  {
    key: "collections.demand_letter",
    label: "Draft demand letters",
    category: "Collections",
  },
  // Escalation matrix — distinct signatory perms for company
  // vs attorney variants. Drafters can't approve their own letters.
  {
    key: "collections.dl_approve_company",
    label: "Approve company demand letters (Ops Manager)",
    category: "Collections",
  },
  {
    key: "collections.dl_approve_legal",
    label: "Approve attorney demand letters (Lawyer)",
    category: "Collections",
  },
  {
    key: "collections.dl_dispatch",
    label: "Dispatch demand letters",
    category: "Collections",
  },
  // Ownership. Assigning is a supervisor act — a collector who can hand
  // accounts to themselves can cherry-pick the easy ones — so it is
  // deliberately NOT in the COLLECTOR role below.
  {
    key: "collections.assign",
    label: "Assign accounts to collectors",
    category: "Collections",
  },

  // Payments
  {
    key: "payments.record",
    label: "Record single payment",
    category: "Payments",
  },
  { key: "payments.bulk", label: "Bulk payment import", category: "Payments" },
  {
    key: "payments.intents",
    label: "Create payment intents",
    category: "Payments",
  },

  // Products
  { key: "products.read", label: "View loan products", category: "Products" },
  {
    key: "products.write",
    label: "Create / edit / delete",
    category: "Products",
  },

  // Screening
  {
    key: "screening.read",
    label: "View AML screenings",
    category: "Screening",
  },
  { key: "screening.run", label: "Re-run screening", category: "Screening" },
  {
    key: "screening.override",
    label: "Override AML match",
    category: "Screening",
  },
  {
    key: "screening.watchlist",
    label: "Manage watchlist",
    category: "Screening",
  },

  // Documents
  { key: "documents.download", label: "Download PDFs", category: "Documents" },

  // Operations
  { key: "jobs.read", label: "View scheduled jobs", category: "Operations" },
  { key: "jobs.run", label: "Manually trigger", category: "Operations" },
  { key: "jobs.configure", label: "Edit cron / pause", category: "Operations" },
  {
    key: "notifications.read",
    label: "View notifications",
    category: "Operations",
  },
  {
    key: "notifications.test",
    label: "Send test notifications",
    category: "Operations",
  },

  // Admin
  { key: "admin.users", label: "Manage users", category: "Admin" },
  {
    key: "admin.roles",
    label: "Manage roles + permissions",
    category: "Admin",
  },
  {
    key: "admin.decision_rules",
    label: "Edit decision rules",
    category: "Admin",
  },
  {
    // The credit survey itself — factors, questions, weights. Distinct
    // from customers.write (scoring ONE borrower) because editing this
    // changes how every future borrower is scored.
    key: "admin.scoring_catalog",
    label: "Edit the credit survey catalog",
    category: "Admin",
  },
  { key: "admin.audit_log", label: "View audit log", category: "Admin" },
  {
    // Ending someone's session is not the same power as editing them,
    // which is why it isn't folded into admin.users. It's the action
    // you want a duty officer or a support lead to hold during an
    // incident — "this laptop was stolen, cut it off" — without also
    // handing them the ability to change roles or reset passwords.
    // Separate key so it can be granted alone, or withheld alone.
    key: "admin.force_logout",
    label: "End a user's sessions / revoke a co-maker link",
    category: "Admin",
  },
  {
    key: "admin.system_config",
    label: "Edit system config (company equity)",
    category: "Admin",
  },
  {
    // GDPR / PH Data Privacy Act §16(c)+(e). Distinct from admin.users
    // and admin.audit_log so the DSAR responder can be granted exactly
    // this scope without also gaining role management or audit-read
    // privileges.
    key: "admin.compliance",
    label: "Respond to data-subject access requests (export + erase)",
    category: "Admin",
  },
  {
    key: "reports.read",
    label: "View / export compliance reports",
    category: "Admin",
  },

  // DORSI compliance
  {
    key: "dorsi.read",
    label: "View DORSI register + dashboard",
    category: "Admin",
  },
  { key: "dorsi.tag", label: "Tag / untag DORSI customers", category: "Admin" },
  {
    key: "dorsi.board_approve",
    label: "Record board approval for DORSI loans",
    category: "Admin",
  },

  // Portal (customer-facing)
  { key: "portal.self", label: "Borrower self-service", category: "Portal" },

  // Cooperative modules (Contributions, Savings, Funds, Expenses, Other Income, Big Brother)
  {
    key: "coop.read",
    label: "View cooperative records",
    category: "Cooperative",
  },
  {
    key: "coop.contribute",
    label: "Record contributions",
    category: "Cooperative",
  },
  {
    key: "coop.savings",
    label: "Record member savings",
    category: "Cooperative",
  },
  { key: "coop.funds", label: "Record fund in/out", category: "Cooperative" },
  { key: "coop.expense", label: "Record expenses", category: "Cooperative" },
  { key: "coop.income", label: "Record other income", category: "Cooperative" },
  {
    key: "coop.big_brother",
    label: "Manage Big Brother capital",
    category: "Cooperative",
  },
];

/**
 * Convenience map: category → permission keys. Drives the role editor UI.
 */
export const PERMISSIONS_BY_CATEGORY: Record<
  PermissionCategory,
  PermissionDefinition[]
> = PERMISSIONS.reduce(
  (acc, p) => {
    (acc[p.category] = acc[p.category] ?? []).push(p);
    return acc;
  },
  {} as Record<PermissionCategory, PermissionDefinition[]>,
);

/** All permission keys as a Set, for runtime validation. */
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSIONS.map((p) => p.key),
);

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
    key: "ADMIN",
    name: "Admin",
    description: "Full access to the platform.",
    system: true,
    permissions: ALL_PERMS,
  },
  {
    key: "LOAN_OFFICER",
    name: "Loan Officer",
    description: "Underwrites loans, runs KYC, manages collections.",
    system: true,
    permissions: [
      "loans.read",
      "loans.apply",
      "pre_assessment.run",
      "pre_assessment.read",
      "loans.decide",
      "loans.disburse",
      "loans.restructure",
      "loans.close_early",
      "loans.sign_officer",
      "loans.docs_renew",
      // Loan Officers can act on the first (Officer) step of any chain.
      // BM / Committee steps require their own role assignments.
      "loans.approve.officer",
      // An officer takes the application, so they are the one who knows
      // which agent brought it in. Read + assign only: setting what an
      // agent is paid stays with the admin, so the person crediting the
      // loan cannot also price it.
      "agents.read",
      "agents.assign",
      "repossession.identify",
      "repossession.assign_agent",
      "repossession.recover",
      "lease.read",
      "lease.buyout",
      "lease.pull_out",
      "lease.close",
      "kyc.read",
      "kyc.submit",
      "kyc.decide",
      "customers.read",
      "customers.write",
      "collections.read",
      "collections.note",
      "collections.demand_letter",
      "collections.dl_approve_company",
      "collections.dl_dispatch",
      // Officers supervise collections per this role's description, so
      // handing accounts out is theirs as well as the admin's.
      "collections.assign",
      "reports.read",
      "screening.read",
      "screening.run",
      /**
       * Read-only DORSI. The customer detail page auto-screens every
       * borrower against the DORSI register and the officer
       * is the one who has to confirm the result before originating —
       * without this the screen 403s and the banner cannot render, which
       * reads to the officer as "screened clean".
       *
       * Deliberately read-only: `dorsi.tag` and `dorsi.board_approve`
       * stay admin-only, so an officer can see a potential match but
       * can't classify a customer or self-approve a DORSI loan.
       */
      "dorsi.read",
      "documents.download",
      "products.read",
      "accounting.read",
      "notifications.read",
    ],
  },
  {
    key: "ACCOUNTANT",
    name: "Accountant",
    description: "Records payments, posts journal entries, reconciles books.",
    system: true,
    permissions: [
      "loans.read",
      "payments.record",
      "payments.bulk",
      "payments.intents",
      "loans.waive_penalty",
      // Paying the agents is cash going out, which is the cashier's
      // desk. Read, to know who is being paid; payout, to pay them.
      // Deliberately NOT agents.manage — an accountant who could set
      // the rate could also set what they hand over.
      "agents.read",
      "agents.payout",
      "accounting.read",
      "accounting.post_journal",
      "accounting.reverse",
      "accounting.close_period",
      "accounting.accrue",
      "accounting.accounts",
      "collections.read",
      "collections.accrue",
      "customers.read",
      "documents.download",
      "products.read",
      "jobs.read",
      "jobs.run",
      "notifications.read",
      "reports.read",
      // Coop cash-handling is accountant territory by default.
      "coop.read",
      "coop.contribute",
      "coop.savings",
      "coop.funds",
      "coop.expense",
      "coop.income",
      "coop.big_brother",
    ],
  },
  {
    key: "COLLECTOR",
    name: "Collector",
    description: "Works assigned delinquent accounts — calls, visits, PTPs.",
    system: true,
    permissions: [
      // The queue and the accounts in it.
      "collections.read",
      "collections.note",
      // A collector needs to open the account they're chasing: the loan
      // itself, its schedule, and who the borrower is. Read-only —
      // nothing here can decide, disburse, restructure or waive.
      "loans.read",
      "customers.read",
      // Demand letters get DRAFTED by whoever is working the account.
      // Approval and dispatch are separate permissions and stay with the
      // Ops Manager and Lawyer — a collector cannot sign off their own
      // letter, which is the whole point of the escalation matrix.
      "collections.demand_letter",
      // Recording money is the accountant's job. A collector who could
      // post payments could paper over a shortfall on their own queue,
      // so payments.record is deliberately absent — they mark a promise
      // to pay and the cashier records the receipt.
      "notifications.read",
      "documents.download",
    ],
  },
  {
    key: "AGENT",
    name: "Field Agent",
    description:
      "Paid commission on loans credited to them. Sees their own book and nothing else.",
    system: true,
    permissions: [
      /*
       * Deliberately tiny.
       *
       * An agent is paid per loan they land, which is exactly the
       * incentive that makes a broad grant dangerous: `loans.read` would
       * let them page through every borrower in the book, and
       * `customers.read` would hand them the coop's entire contact list
       * to take to a competitor. `agents.self` returns only rows already
       * assigned to the signed-in agent, so the scope is enforced by the
       * endpoint rather than trusted to the UI.
       *
       * `loans.apply` was here on the reasoning that bringing
       * applications in is the job. Removed on inspection: it was
       * simultaneously unusable and too broad.
       *
       * Unusable, because origination runs through the new-loan wizard
       * and its borrower picker calls GET /customers, which needs
       * `customers.read`. An agent opening the wizard got a picker that
       * 403s and no way to choose anyone.
       *
       * Too broad, because POST /loans/apply is the officer-mediated
       * path and takes ANY customerId in the body — there is no
       * scoping to borrowers this agent introduced. Granting it meant
       * anyone holding a customer uuid could originate against a
       * borrower they have no relationship with.
       *
       * Giving them `customers.read` to make the wizard work would hand
       * a commissioned salesperson the coop's entire borrower list,
       * which is the thing this role is narrow to avoid. So the flow
       * stays as the rest of the module already assumes: an officer
       * takes the application and credits the agent with
       * `agents.assign`. The agent is attributed, not the operator.
       */
      "agents.self",
      "notifications.read",
    ],
  },
  {
    key: "CUSTOMER",
    name: "Customer",
    description: "Self-serve borrower account.",
    system: true,
    permissions: ["portal.self"],
  },
];

/** Used by the seed script + by the runtime when reconciling on boot. */
export const DEFAULT_ROLE_BY_KEY: Record<string, RoleDefinition> =
  Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, r]));
