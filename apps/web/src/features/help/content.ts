/**
 * Help content registry — one entry per module. The HelpPage + help
 * drawer render from this list, and each module's TourButton points at
 * the `tourId` + steps defined here.
 *
 * Keep entries terse and operator-focused: "what does this page do" +
 * "what's the typical flow" + "common gotchas". The FAQ at the bottom
 * of the help page collects cross-module questions.
 *
 * To add help for a new module:
 *   1. Append a new HelpArticle below.
 *   2. (Optional) wire its `tourId` into a useTour() call on that page.
 *   3. (Optional) drop a "Take a tour" button on the page header.
 */

import type { TourStep } from "@loan/ui";

export interface HelpArticle {
  /** Stable id — used as the URL anchor on /help and as the tour key. */
  id: string;
  /** Display label. */
  title: string;
  /** Module / section grouping for the help drawer. */
  category:
    | "Onboarding"
    | "Lending"
    | "Servicing"
    | "Accounting"
    | "Compliance"
    | "Cooperative"
    | "Admin"
    | "Intelligence";
  /** Short one-liner shown in the help drawer list. */
  summary: string;
  /** Long-form body — Markdown-style plain paragraphs separated by blank lines. */
  body: string;
  /** Optional tour steps. When set, the page header shows "Take a tour". */
  tour?: TourStep[];
  /** Route the article lives on, used for the "Open module" deep link. */
  route?: string;
}

const t = (
  selector: string,
  title: string,
  description: string,
  side: "left" | "right" | "top" | "bottom" = "bottom",
): TourStep => ({
  element: selector,
  popover: { title, description, side, align: "start" },
});

export const HELP_ARTICLES: HelpArticle[] = [
  // ── Onboarding ────────────────────────────────────────────────────
  {
    id: "getting-started",
    title: "Getting started",
    category: "Onboarding",
    summary: "The first 10 minutes — what this system does and where to click.",
    route: "/",
    body:
      "SmartLoan handles the full lifecycle of a loan: take an application, score the borrower, decide, disburse, service the schedule, post to the GL, collect when overdue, and report on it all.\n\n" +
      "Roles: ADMIN sees everything. LOAN_OFFICER underwrites + collects. ACCOUNTANT books payments + closes periods + runs reports. CUSTOMER is the borrower portal (separate UI).\n\n" +
      "Sidebar groups: Customers & loans (origination), Servicing (collections + bulk payments), Accounting, Cooperative, Risk & compliance, Administration. The chevron on each group toggles it open/closed and remembers your last open section.",
    tour: [
      t(
        '[data-tour="nav-sidebar"]',
        "Navigation",
        "Modules are grouped by what they do. Click a group to expand it; only one stays open at a time.",
        "right",
      ),
      t(
        '[data-tour="navbar-audit"]',
        "Audit log",
        "Every privileged action lands here — useful when investigating a change.",
      ),
      t(
        '[data-tour="navbar-notifications"]',
        "Notifications",
        "Inbox for system notifications. Unread count appears as a badge.",
      ),
      t(
        '[data-tour="navbar-profile"]',
        "Your profile",
        "Profile, settings (2FA, signature), and log out live here.",
      ),
    ],
  },

  // ── Lending ───────────────────────────────────────────────────────
  {
    id: "customers",
    title: "Customers",
    category: "Lending",
    summary: "Borrower roster — onboard, KYC, credit-score, view loan history.",
    route: "/customers",
    body:
      'Add a new customer with the "New customer" button. Required fields include government ID and employment status — both feed the scoring engine.\n\n' +
      "Speed up onboarding with the \"Scan ID to pre-fill form\" card at the top of the new-customer dialog: drop a clear photo of the borrower's gov't ID and Tesseract.js extracts name, date of birth, and ID number locally in your browser. The image never leaves the machine. Officer reviews + edits before saving.\n\n" +
      "After save, AML screening runs in the background. If a potential DORSI match is detected on the customer profile, a banner appears at the top — confirm or dismiss before booking a loan.\n\n" +
      "Click a customer name to open the detail page: KYC documents, credit score, loan history, AML screening, DORSI status.",
    tour: [
      t(
        '[data-tour="customers-new"]',
        "New customer",
        "Captures the full KYC profile in one form.",
      ),
      t(
        '[data-tour="customers-table"]',
        "Customer list",
        "Click any row to open the quick-view drawer. Click the name to open the full profile.",
      ),
    ],
  },
  {
    id: "kyc",
    title: "KYC review",
    category: "Lending",
    summary: "Verify or reject submitted documents per customer.",
    route: "/kyc",
    body:
      "Queue of customers with PENDING documents. Click a customer name to open the inspector drawer with all their docs, the AML screening, and approve/reject buttons in one panel.\n\n" +
      "Required docs are per-product — Auto loans need OR/CR, Mortgages need property title + tax declaration. The customer's KYC pack must clear before /loans/:id/decide unblocks.",
    tour: [
      t(
        '[data-tour="kyc-queue"]',
        "Pending queue",
        "Every customer with at least one PENDING document appears here. Click a name to open the inspector drawer.",
      ),
    ],
  },
  {
    id: "loans-list",
    title: "Loans",
    category: "Lending",
    summary: "Master loan list — apply, decide, disburse, service.",
    route: "/loans",
    body:
      "Each row is a loan in some status (DRAFT → SUBMITTED → APPROVED → DISBURSED → ACTIVE → CLOSED, with side-branches for REJECTED / WRITTEN_OFF / DEFAULTED).\n\n" +
      'Click the loan number for a quick-view drawer with key facts + next due. Click "New application" to start the 5-step wizard — see the "Loan application wizard" help article for the full walkthrough.\n\n' +
      'When you have saved drafts, a "Drafts (N)" button appears next to "New application". Click it to see your in-progress applications and resume any of them — drafts persist across sessions and devices.',
    tour: [
      t(
        '[data-tour="loans-new"]',
        "New application",
        "Opens the 5-step wizard: Borrower → Product & Terms → Collateral & Co-makers → Verification → Review.",
      ),
      t(
        '[data-tour="loans-table"]',
        "Loans table",
        "Click a number for the quick drawer; click into a row for the full loan detail.",
      ),
    ],
  },
  {
    id: "loan-apply-wizard",
    title: "Loan application wizard",
    category: "Lending",
    summary:
      "The 5-step apply flow — drafts, smart guardrails, pre-decisioning preview.",
    route: "/loans/new",
    body:
      "The new-loan page is a guided 5-step wizard:\n\n" +
      '  1. Borrower — pick the customer. The borrower context bar loads inline: monthly income, KYC status, credit score + tier, repeat-borrower flag, DORSI flag, prior-default history. Traffic-light hints fire automatically (e.g. "KYC pending — loan can\'t be decided until verified").\n\n' +
      "  2. Product & Terms — pick the product, then principal / term / APR. As you type, three smart panels update live:\n" +
      "       • KYC gap warning — checklist of required docs for THIS product. Submit is blocked until every required doc is VERIFIED.\n" +
      "       • Affordability — monthly EMI, debt-to-income ratio, max-safe principal at the chosen term.\n" +
      "       • DORSI cap projection — only when the customer is DORSI-tagged; shows projected aggregate + per-borrower utilization.\n\n" +
      "  3. Collateral & Co-makers — conditional collateral fieldset (auto-hidden for unsecured products) plus optional co-makers (full name + phone + role + relationship).\n\n" +
      "  4. Verification — application selfie via the live camera + free-form purpose / notes.\n\n" +
      "  5. Review — read-only summary plus the pre-decisioning preview (stoplight verdict + matched rule + anomaly flags) before you commit.\n\n" +
      '"Save draft" lives in the page header on every step. Auto-save also fires on every Next click — best-effort, never blocks. Drafts are private per officer and resume from where you left off. On final Submit, the draft auto-deletes and you land on the loan detail page.',
    tour: [
      t(
        '[data-tour="wizard-stepper"]',
        "5 steps",
        "Borrower → Product & Terms → Collateral & Co-makers → Verification → Review. Click any completed step (green check) to revisit it without losing your inputs.",
      ),
      t(
        '[data-tour="wizard-body"]',
        "Current step",
        "The work area shows just the current step's fields. Smart panels (KYC gap, affordability, DORSI projection, pre-decisioning) appear inline on the steps where they're useful.",
      ),
      t(
        '[data-tour="wizard-next"]',
        "Next button",
        "Disabled until the current step's required fields are filled. On click, the wizard auto-saves your progress as a draft and advances.",
        "top",
      ),
      t(
        '[data-tour="wizard-save"]',
        "Save draft",
        "Manual save anytime. Auto-save already fires on every Next, so this is mostly for when you want to confirm a save before leaving the page.",
      ),
    ],
  },
  {
    id: "loan-detail",
    title: "Loan detail",
    category: "Lending",
    summary:
      "One loan — schedule, payments, signatures, lease/penalty/docs panels.",
    body:
      "The right panel rail shows everything related to the loan: amortization schedule, signed agreement PDFs, payments, penalties, annual documents (insurance / RPT), and (for lease products) the lease agreement with buyout / pull-out actions.\n\n" +
      "Decide / Disburse / Pay / Restructure / Write-off live on this page — they're permission-gated so the right role gets the right buttons.",
  },

  // ── Servicing ─────────────────────────────────────────────────────
  {
    id: "collections",
    title: "Collections",
    category: "Servicing",
    summary: "Overdue queue — call notes, promises to pay, late-fee accrual.",
    route: "/collections",
    body:
      "Every loan with an overdue installment shows here, sorted by severity. Click a loan number for the case drawer: full note timeline, active PTPs, recent payments, plus inline forms to add notes / record promises.\n\n" +
      "Late-fee accrual runs nightly. If a borrower part-pays, FIFO allocation applies: penalties first, then oldest unpaid interest, then oldest unpaid principal.",
    tour: [
      t(
        '[data-tour="collections-table"]',
        "Overdue queue",
        "Sorted by days overdue. Click a loan number for the case drawer with notes / PTPs / payments.",
      ),
    ],
  },
  {
    id: "demand-letters",
    title: "Demand letters",
    category: "Servicing",
    summary: "Batch-generate First / Final demand letters per FRD §3.6.",
    route: "/collections/demand-letters",
    body:
      "Workflow: filter by stage (First 60d+, Final 90d+, Attorney variants), click Display to fetch candidates, tick rows to generate, then Generate creates DRAFTED letters.\n\n" +
      "FRD §3.6.5 escalation matrix: drafters cannot self-approve. Operations Manager approves company letters; Lawyer approves Attorney variants. APPROVED letters can then be Dispatched — borrower gets a notification.\n\n" +
      "View any letter's body in the right-side drawer. Mark RESPONDED when the borrower pays, or WAIVE if there's special handling.",
    tour: [
      t(
        '[data-tour="dl-stage"]',
        "Stage filter",
        "FRD §3.6 thresholds: First at 60+ days, Final at 90+, Attorney variants at 120+ / 150+.",
      ),
      t(
        '[data-tour="dl-display"]',
        "Display candidates",
        "Pulls eligible loans. Existing active letters at the same stage are excluded automatically.",
      ),
      t(
        '[data-tour="dl-status-filter"]',
        "Status filter",
        "Switch to DRAFTED to find letters waiting on approval, APPROVED to find ones ready for dispatch.",
      ),
    ],
  },
  {
    id: "repossession",
    title: "Repossession",
    category: "Servicing",
    summary: "Vehicle recovery state machine — BM → Credit → Legal → Agent.",
    route: "/repossession",
    body:
      "One case per loan, advancing through the FRD-prescribed approval chain. Identify the loan, then push through Branch Manager → Credit Head → Legal approvals before an Agent can be dispatched.\n\n" +
      "After Recovery, capture vehicle condition + mileage + storage location. Auction settlement applies proceeds against the loan; any deficiency is written off to bad debt.\n\n" +
      "Cases are cancellable at any pre-RECOVERED state (e.g. borrower pays at the last minute, restructure approved).",
    tour: [
      t(
        '[data-tour="repo-identify"]',
        "Identify case",
        "Opens a case against a delinquent auto/lease loan. The chain of approvals starts from here.",
      ),
      t(
        '[data-tour="repo-cases"]',
        "Cases list",
        "Filter by status. Each row's action column surfaces the next-step button (BM, Credit, Legal, Agent, Auction…) gated by your permissions.",
      ),
    ],
  },
  {
    id: "bulk-payments",
    title: "Bulk payments",
    category: "Servicing",
    summary: "CSV upload to apply many payments at once.",
    route: "/payments/bulk",
    body:
      "Drop a CSV with columns: loanNumber, amount, paidOn, reference. The importer validates per row before posting — anything that fails (no loan match, amount > outstanding, etc.) is skipped with a reason in the result table.\n\n" +
      "Each accepted row goes through the same recordPayment flow as a single payment, so FIFO allocation + journal posting are identical.",
  },

  // ── Accounting ────────────────────────────────────────────────────
  {
    id: "accounting",
    title: "Accounting dashboard",
    category: "Accounting",
    summary: "Trial balance, balance sheet, income statement, journal entries.",
    route: "/accounting",
    body:
      "Full double-entry GL. Every cash movement in the system auto-posts a balanced journal entry: disburse, payment, late-fee accrual, ECL provision, cooperative contribution, lease buyout, etc.\n\n" +
      'Use the Journal entries page to inspect any entry — click the "Posted" badge anywhere in the app to open the same drawer. Periods can be closed (no posting allowed) and reopened from /accounting/periods.',
    tour: [
      t(
        '[data-tour="accounting-stats"]',
        "Daily snapshot",
        "Cash on hand, loans receivable, net income YTD, and delinquent balance — refreshed on every page load.",
      ),
      t(
        '[data-tour="accounting-reports"]',
        "Statement reports",
        "Trial balance, P&L, balance sheet, and portfolio aging — open any one for the underlying detail.",
      ),
      t(
        '[data-tour="accounting-aging"]',
        "Aging buckets",
        "Outstanding principal grouped by days-overdue. Lines up with what Collections is working.",
      ),
    ],
  },
  {
    id: "ecl",
    title: "ECL provisioning (IFRS 9)",
    category: "Accounting",
    summary: "Stage-1/2/3 expected credit loss with auto GL posting.",
    route: "/accounting/ecl",
    body:
      "Each run classifies every active loan into Stage 1 / 2 / 3 by DPD, computes ECL = PD × LGD × EAD, persists the new stage + provision on each loan, then books the period-over-period delta to the GL (Dr Impairment Loss / Cr Allowance for Doubtful).\n\n" +
      "Per-product PD/LGD lives on LoanProduct. Re-running for the same day is idempotent — only the delta posts.",
  },
  {
    id: "reconciliation",
    title: "Bank reconciliation",
    category: "Accounting",
    summary: "Match bank statement lines to loan payments / disbursements.",
    route: "/reconciliation",
    body:
      "Import a bank statement (CSV). Auto-match attempts to pair each line with a LoanPayment (credits) or LoanApplication.disbursedAt (debits) by amount + date proximity + reference.\n\n" +
      'Unmatched lines surface in the line drawer — pick from suggested candidates (scored) or apply a manual match (e.g. "MANUAL · bank fee").',
    tour: [
      t(
        '[data-tour="recon-import"]',
        "Import statement",
        "Upload a CSV from your bank. Each line auto-matches where possible; the rest surface for manual reconciliation.",
      ),
      t(
        '[data-tour="recon-list"]',
        "Imported statements",
        "Click a label to open the line view — auto-matched, unmatched, and manually attached lines all in one place.",
      ),
    ],
  },

  // ── Compliance ────────────────────────────────────────────────────
  {
    id: "dorsi",
    title: "DORSI compliance",
    category: "Compliance",
    summary: "Director/Officer/Stockholder/Related-Interest tracking + caps.",
    route: "/compliance/dorsi",
    body:
      "Per FRD §3.10: DORSI loans are capped at 15% of Company Total Equity in aggregate, with no single borrower exceeding 30% of that aggregate cap.\n\n" +
      "Tag known DORSI customers in the Register. The Utilization card shows real-time aggregate + per-borrower exposure with threshold alerts at 80% / 90% / 100%. Loans that would breach the cap require a recorded Board Approval before disburse.\n\n" +
      "Company Total Equity is configurable in the System Config card — set it each quarter from the latest balance sheet.",
    tour: [
      t(
        '[data-tour="dorsi-utilization"]',
        "Utilization gauge",
        "Shows aggregate exposure against the 15% cap. Threshold alerts at 80% / 90% / 100%.",
      ),
      t(
        '[data-tour="dorsi-register"]',
        "Register",
        'Click "Tag customer" to add a DORSI record. Re-tagging an existing customer updates category + basis.',
      ),
      t(
        '[data-tour="dorsi-config"]',
        "System config",
        "Company Total Equity is the base for the 15% cap. Update each quarter.",
      ),
    ],
  },
  {
    id: "annual-docs",
    title: "Renewable documents",
    category: "Compliance",
    summary: "Track car insurance / RPT / OR-CR expiry with reminders.",
    route: "/compliance/annual-docs",
    body:
      "Per FRD §3.8: annual docs (car insurance, real-property tax, fire insurance) must be renewed throughout the loan term. Capture each submission with effectiveFrom + expiresAt; status (VALID / EXPIRING_SOON / EXPIRED) is computed and refreshed nightly.\n\n" +
      "The daily reminder job emails / SMSes the borrower 30 days before expiry and again on lapse. Filter the dashboard by window to spot what needs follow-up this week.",
    tour: [
      t(
        '[data-tour="annualdocs-window"]',
        "Horizon window",
        "Pick how far ahead to look — 7 / 30 / 60 / 90 days. The list re-fetches accordingly.",
      ),
      t(
        '[data-tour="annualdocs-refresh"]',
        "Refresh statuses",
        "Recomputes VALID / EXPIRING_SOON / EXPIRED on every doc. Normally runs nightly — only press if you need it sooner.",
      ),
    ],
  },
  {
    id: "reports",
    title: "Compliance reports",
    category: "Compliance",
    summary: "Exportable CSVs for monthly + quarterly audits.",
    route: "/reports",
    body:
      "Six reports keyed to the FRD audit clauses:\n\n" +
      "· DORSI utilization (§3.10.6) — snapshot of per-borrower exposure\n" +
      "· Penalty waivers (§3.3.7) — original vs negotiated amounts + reason\n" +
      "· Demand letters (§3.6) — stage, status, approver, dispatcher\n" +
      "· Repossession cases (§3.7.7) — full state-machine timeline + auction proceeds\n" +
      "· Annual docs compliance (§3.8.6) — % valid / expiring / expired\n" +
      "· ECL movement (§3.4.3) — per-run stage breakdown + delta\n\n" +
      "Each downloads as a CSV with a date-range filter where applicable. Pull into Excel / Sheets for review.",
    tour: [
      t(
        '[data-tour="reports-grid"]',
        "Report cards",
        "Each card is one FRD-mapped report. Date-range pickers appear where applicable; click Download CSV to grab a snapshot.",
      ),
    ],
  },

  // ── Cooperative ───────────────────────────────────────────────────
  {
    id: "cooperative",
    title: "Cooperative modules",
    category: "Cooperative",
    summary: "7 tabs — contributions, savings, funds, expenses, big-brother.",
    route: "/cooperative",
    body:
      'Each entity (contribution, savings, fund movement, withdrawal, expense, other income, big-brother capital) has its own tab with a list + "New" button. Every write auto-posts to the GL — no manual journals required.\n\n' +
      "Click any member name to open the member ledger drawer with their lifetime CBU / Mortuary / Emergency totals and recent activity.",
    tour: [
      t(
        '[data-tour="coop-tabs"]',
        "Module tabs",
        "Seven sub-modules — pick one. Every write auto-posts a journal entry, no manual debits / credits needed.",
      ),
    ],
  },

  // ── Admin ─────────────────────────────────────────────────────────
  {
    id: "rbac",
    title: "Roles & permissions",
    category: "Admin",
    summary:
      "Roles, permissions, inheritance, staging, and the safety guards that keep the org from locking itself out.",
    route: "/roles",
    body:
      "Roles are sets of permissions. The four canonical roles (ADMIN, LOAN_OFFICER, ACCOUNTANT, CUSTOMER) ship as system roles — editable but never deletable. Custom roles can be created at any time and freely deleted when no users hold them.\n\n" +
      "The /roles page stacks three admin panels above the role list:\n\n" +
      '  • "Who has permission…?" — reverse lookup. Pick a permission key and the panel shows every role + every active delegation currently granting it, plus a deduped count of unique users. Answers questions like "if I remove loans.decide from LOAN_OFFICER, who actually loses access?".\n' +
      "  • Permission catalog — every permission with a lifecycle status pill (DRAFT / ACTIVE / DEPRECATED). Search, filter by status, and (admin-only) click → ACTIVE / → DRAFT / → DEPRECATED to flip a permission's state. DRAFT is the staging state: the perm exists in the catalog and can be assigned to roles, but the resolver doesn't actually grant it. Useful for wiring role membership ahead of a feature launch. DEPRECATED still grants at runtime (so in-flight flows don't break) but is flagged for planned removal.\n" +
      "  • Roles table — name, permission count, user count, system/custom badge. Click the pencil to edit.\n\n" +
      "Role editor (the dialog):\n\n" +
      '  • "Inherits from" — pick zero or more parent roles. The effective permission set of this role becomes the union of its own perms plus every parent\'s (transitively). Cycles are rejected on save with the offending path in the error message.\n' +
      "  • Permission matrix — checkbox grid grouped by category. Tick what this role grants directly.\n" +
      '  • Edit-impact safety net — when you press Save on an existing role, the system computes "who would lose what" before writing. If any active user would lose a permission because of YOUR change (i.e. this role was their sole grant), you get a confirmation dialog listing each removed permission and the user count it affects. No surprise lockouts.\n\n' +
      "Last-admin guard — the system refuses to remove ADMIN from the only remaining active admin. Returns 409 Conflict with a message telling you to promote someone else first. Self-lockout guard (you can't remove your own ADMIN) is the simpler cousin of this.\n\n" +
      "Bulk operations:\n\n" +
      "  • One user at a time — /users page → New user.\n" +
      "  • Many users at once — /users/bulk (admin-only). Drop a CSV, dry-run validates without writing, then commit. Per-row partial success — fix and resubmit just the failed rows.\n\n" +
      "Notifications: every role assignment + removal sends a best-effort USER_ROLE_CHANGED email to the affected user (when they have an email on file). Best-effort means: dispatch failure doesn't roll back the role change — the change still happens, the email just doesn't go out, and a warning lands in the api log.",
    tour: [
      t(
        '[data-tour="permission-holders-panel"]',
        "Who has permission X?",
        "Reverse lookup. Pick a permission to see every role + active delegation that currently grants it. Useful before removing a perm from a role.",
      ),
      t(
        '[data-tour="permission-catalog-panel"]',
        "Permission catalog",
        "Every permission with its lifecycle status. DRAFT permissions don't grant at resolve time even when assigned to a role — useful for wiring up before feature launch.",
      ),
    ],
  },
  {
    id: "bulk-users",
    title: "Bulk user onboarding",
    category: "Admin",
    summary:
      "Drop a CSV to create staff accounts in one go. Dry-run validates without committing.",
    route: "/users/bulk",
    body:
      "Admin-only. Each row creates one User and (optionally) assigns extra roles on top of the primary role. Up to 500 rows per batch.\n\n" +
      "Required columns: email, name, password, role. Optional: customerId (only when role is CUSTOMER — must be an existing customer UUID with no user linked), extraRoles (comma-separated additional role keys to assign post-create).\n\n" +
      "Flow:\n\n" +
      "  1. Click Template to download a starter CSV with the column headers.\n" +
      "  2. Drop your filled CSV on the dropzone OR paste it into the textarea.\n" +
      '  3. Click "Dry run" — every row is validated (zod + email collision + customer-link invariants) without touching the DB. The results table shows which rows would succeed and which would fail.\n' +
      "  4. Fix any failures (re-edit the CSV — comments and blank lines are skipped), then click Import.\n\n" +
      'Partial success is the default — one bad row doesn\'t block the others. Toggle "Stop on first error" if you want the opposite. The response is 207 Multi-Status with a per-row breakdown: ok / failed + error message.\n\n' +
      "Each successful row writes a USER_CREATE audit entry; the batch itself writes one summary BULK_USER_IMPORT entry with the counts. The Users page invalidates and reloads once at least one user actually committed (dry-runs don't trigger a refetch).\n\n" +
      "Common mistakes:\n" +
      "  • Reusing an email — collides with an existing user.\n" +
      "  • CUSTOMER without a customerId — creates a standalone account, no portal access until linked.\n" +
      "  • extraRoles containing a typo — the user is still created, but the specific bad role doesn't attach (row marked as partial-fail with the role name in the error).",
    tour: [
      t(
        '[data-tour="bulk-users-panel"]',
        "Bulk user import",
        "Drop a CSV here or paste below. Each row spawns one User plus optional secondary roles.",
      ),
      t(
        '[data-tour="bulk-users-actions"]',
        "Dry run first",
        "Always click Dry run before Import. It validates every row against the schema + checks email collisions + customer-link invariants without writing anything.",
        "top",
      ),
    ],
  },
  {
    id: "users-page",
    title: "Users + temporary role grants",
    category: "Admin",
    summary:
      "Per-user role management. Includes temporary grants (auto-expire) for acting-role coverage.",
    route: "/users",
    body:
      "The /users page is the per-user view of the same RBAC world that /roles administers. Each row shows the user's primary role (from the legacy User.role enum), every additional role they're assigned, status, and creation date.\n\n" +
      'Click "Assign" on any row to open the assign-role dialog. The dialog has two parts:\n\n' +
      '  • "Temporary grant" toggle at the top + a datetime picker. When checked, the grant carries an expiresAt — the permission resolver stops including the role\'s perms after that instant, automatically. No cron, no cleanup script needed; the assignment row stays in the DB for the audit trail but goes inert.\n' +
      "  • Role list below. Click any role to commit the assignment with whatever temporary/perpetual config is set above.\n\n" +
      'On the user\'s row, temporary grants get a badge suffix like "until 2026-06-12" so admins can see at-a-glance which assignments are time-bounded. Expired grants are shown with strike-through so you know the row is still on file but no longer effective.\n\n' +
      'Re-assigning the same role with a new expiresAt is the "extend" path — it updates expiry in place without disturbing the original grantedById/grantedAt. Pass an empty/null expiresAt to promote a temporary grant to perpetual.\n\n' +
      "Past-dated expiries are rejected at the API as BadExpiry — recording a born-expired grant has no semantic value and would confuse the audit trail.",
  },
  {
    id: "delegations",
    title: "Delegations",
    category: "Admin",
    summary:
      "Time-bounded proxy authority — cover for someone on leave without giving them your password.",
    route: "/delegations",
    body:
      "A delegation lets another user temporarily inherit your permissions. They use their own login, but during the window the system treats their session as having the listed permissions too. When the window closes (or you revoke), the delegate is back to just their own role.\n\n" +
      'The page has two lists — "Granted to me" (incoming) and "Granted by me" (outgoing). Filter chips at the top (Active / Scheduled / Expiring soon / Expired / Revoked) plus a text search by delegate name make it manageable once you have a dozen+ delegations on file.\n\n' +
      "Common workflows:\n" +
      '  • Branch coverage — open the wizard, pick the user, click "Delegate as LOAN_OFFICER" (or any role with permissions). The role template pre-fills the permission list with that role\'s permissions. Edit afterward to fine-tune.\n' +
      '  • Need more time — on an active delegation, click "+ 7d" to push the end date by a week. No revoke-and-recreate needed.\n' +
      '  • Pulling it back early — click "Revoke" with an optional reason. The delegate loses the permissions immediately and the reason lands in the audit log.\n' +
      "  • \"What does this actually grant me?\" — click Preview on any delegation row. The dialog shows the resolved permission set the delegate would receive RIGHT NOW (after re-checking the delegator's current permissions) plus any explicit keys that have been DROPPED because the delegator no longer holds them. Empty droppedPermissions means the delegation is still fully effective; non-empty means something changed on the delegator's side and the delegate has silently lost coverage of those keys.\n\n" +
      "Safety notes: you can only delegate permissions you actually hold; downgrading the delegator (e.g. removing a role from them) instantly tightens what their delegate inherits — that's the silent-drop case the Preview catches. Every create / extend / revoke writes an audit row.\n\n" +
      "Notifications: revoking a delegation triggers a best-effort DELEGATION_REVOKED email to the delegate (and they also see the change immediately the next time they hit a permission-gated route).",
    tour: [
      t(
        '[data-tour="delegations-new"]',
        "Start here",
        "Opens the new-delegation dialog. Pick a delegate, set the window, then either click a role template or hand-pick permissions.",
      ),
      t(
        '[data-tour="delegations-filters"]',
        "Filters + search",
        "Chips show counts per status. Click any chip to filter the two lists below. Search by delegate name, email, or note.",
      ),
    ],
  },
  {
    id: "audit-log",
    title: "Audit log",
    category: "Admin",
    summary: "Append-only record of every privileged action.",
    body:
      "Open via the scroll icon in the top navbar. Filter by action label + actor name; click any row to expand the JSON payload.\n\n" +
      "Sensitive routes (loans.decide, loans.disburse, journal.reverse, dorsi.tag, repossession.*, etc.) record automatically. Read-only — no delete or edit.",
  },

  // ── Intelligence ──────────────────────────────────────────────────
  //
  // These four features run "smart" workflows entirely on infrastructure
  // you control. They never call OpenAI / Anthropic / any cloud AI —
  // financial-services data sovereignty is a hard requirement. The
  // mock-when-not-configured pattern means the UI works in dev with
  // zero external dependencies.
  {
    id: "ai-assistant",
    title: "AI assistant (local LLM)",
    category: "Intelligence",
    summary:
      "Drafts demand letters, explains decisions, summarizes accounts — runs on your server.",
    body:
      "The AI assistant card appears on the loan detail page (and other surfaces). It runs a local LLM via Ollama — your data never leaves your infrastructure.\n\n" +
      "Three tasks today:\n" +
      "  • Explain decision — plain-language summary of why the engine reached its verdict.\n" +
      "  • Draft demand letter — first-pass body for FIRST / FINAL / Attorney variants.\n" +
      "  • Summarize account — borrower history rollup (loan count, payment behavior, open balance, verdict).\n\n" +
      'The assistant is an opt-in feature. With no Ollama service running, the panel shows "Mock · not ready" and the buttons return canned configure-Ollama hints. To enable real responses, install Ollama on the host (https://ollama.com), then:\n\n' +
      "  ollama pull phi3:mini\n" +
      "  export OLLAMA_URL=http://localhost:11434  # then restart api\n\n" +
      'Important: the LLM is a drafting assistant, not a decision-maker. Every response carries a "Review before using" disclaimer. The officer always edits the output before sending or saving. Every assistant call is audit-logged (action + model + token count), but the prompt + response bodies are intentionally NOT logged (PII size).',
  },
  {
    id: "id-ocr",
    title: "ID OCR (auto-fill from photo)",
    category: "Intelligence",
    summary:
      "Drop a gov't ID photo on the new-customer form to pre-fill name / DOB / ID number.",
    body:
      'The "Scan ID to pre-fill form" card at the top of the New Customer dialog accepts JPG / PNG / WebP up to 5 MB. Tesseract.js (~3 MB model, lazy-loaded on first use) runs in your browser to extract fields:\n\n' +
      '  • Name (from labelled "Surname:" / "Given Names:" lines, or the longest ALL-CAPS line as fallback)\n' +
      "  • Date of birth (MM/DD/YYYY, DD MON YYYY, YYYY-MM-DD — normalized to ISO)\n" +
      "  • ID number (alphanumeric with hyphens, excludes date-looking strings)\n" +
      "  • Address (when labelled)\n\n" +
      'Click "Apply to form" to fill the form — only empty fields are overwritten, so the officer\'s manual edits always win. "Show raw OCR text" exposes the full recognized text for debugging.\n\n' +
      "The image never leaves the browser. Accuracy is ~80% on clean photos; lower on skewed or low-light shots. Officers always review the extracted values before saving.",
  },
  {
    id: "face-match",
    title: "Face match (selfie ↔ ID)",
    category: "Intelligence",
    summary:
      "Browser-local face similarity check between application selfie and verified ID photo.",
    body:
      "The face-match panel appears on the loan detail page when both inputs are available: an application selfie AND a VERIFIED ID_FRONT KYC submission. The compare uses face-api.js — no pixel data ever crosses your backend.\n\n" +
      'Click "Run face match" to lazy-load ~6 MB of model weights and compute a similarity score (0..1, higher = better match).\n\n' +
      'Threshold: score ≥ 0.55 → "Likely match" (green). Score < 0.55 → "Flag for review" (red). The score persists onto the loan + writes an audit-log row regardless of outcome (LOAN_SELFIE_MATCH_PASSED / LOAN_SELFIE_MATCH_FAILED).\n\n' +
      "Common errors and fixes:\n" +
      '  • "No face detected in the selfie" → poor lighting or sunglasses, retake.\n' +
      '  • "No face detected on the ID" → ID image too small / blurry, re-upload.\n' +
      '  • "Model weights couldn\'t be reached" → set VITE_FACE_API_MODELS or self-host /models/ in the web public folder.\n\n' +
      'Click "Re-run" anytime — useful after the borrower re-submits a clearer selfie.',
  },
  {
    id: "anomaly-flags",
    title: "Anomaly flags",
    category: "Intelligence",
    summary: "Stats-based outlier detection for loan applications.",
    body:
      "Anomaly flags appear in the pre-decisioning preview (bottom of the loan wizard) and as audit-log rows on actual /apply calls. Six codes:\n\n" +
      "  • PRINCIPAL_OUTLIER — requested principal is ≥2σ from the product's historical mean.\n" +
      "  • TERM_OUTLIER — term in months ≥2σ from baseline.\n" +
      "  • RATE_OUTLIER — APR ≥2σ from baseline. Catches mis-keyed rates.\n" +
      '  • APPLICANT_VELOCITY — 3+ non-DRAFT applications from this customer in the last 30 days. 5+ is "high" severity.\n' +
      "  • PRINCIPAL_TO_INCOME — requested principal > 30× monthly income (>60× is high). Soft check for unsecured products.\n" +
      "  • INSUFFICIENT_BASELINE — fewer than 10 historical loans for this product, so stats are skipped. Diagnostic, not actionable.\n\n" +
      "Flags don't block submission — they're informational signals the officer / decisioner should consider. Medium + high severity flags are audit-logged at /apply as LOAN_APPLICATION_FLAGGED events.",
  },
  {
    id: "install-pwa",
    title: "Install as an app",
    category: "Intelligence",
    summary: "SmartLoan is a PWA — installable on desktop and mobile.",
    body:
      'On Chrome / Edge / Brave / Firefox: click the install icon in the address bar, or use the bottom-right "Install SmartLoan" banner when it appears.\n\n' +
      'On iOS Safari: Share → "Add to Home Screen". On Android Chrome: the install prompt appears automatically after a few visits.\n\n' +
      'Once installed, SmartLoan launches in its own standalone window (no browser chrome) and gets a desktop / home-screen icon. When you deploy a new build, the bottom-right "New version available" banner appears — click "Reload now" when you\'re at a safe stopping point (save in-progress work first, since reloading clears form state).\n\n' +
      "Note: SmartLoan is \"installable, not fully offline\". Financial data must always be fresh — we deliberately don't cache loan balances, decisions, or audit records. If the network drops mid-action, you'll see a friendly offline page until connection returns. Officer-side decision-making always uses live data.",
  },
];

/** Group by category for the help page sections. */
export function groupByCategory(): Record<
  HelpArticle["category"],
  HelpArticle[]
> {
  return HELP_ARTICLES.reduce(
    (acc, a) => {
      (acc[a.category] = acc[a.category] ?? []).push(a);
      return acc;
    },
    {} as Record<HelpArticle["category"], HelpArticle[]>,
  );
}

export function findArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.id === id);
}

/** Cross-module FAQ — shown at the bottom of /help. */
export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "A button I expect to see is missing — what gives?",
    a: "Buttons are permission-gated. Open the audit log icon in the navbar — if you can't see it either, you don't have admin.audit_log, and similar gates apply elsewhere. Ask an ADMIN to grant the relevant permission via /roles, or ask the loan officer to delegate it for a time window.",
  },
  {
    q: "How do I record a payment that arrived via bank transfer?",
    a: "Two options. (1) Open the loan detail page → Pay → enter amount + reference. (2) Import the bank statement at /reconciliation and auto-match will pair credits to payments automatically. The second option is better when many came in at once.",
  },
  {
    q: "Why won't /loans/:id/decide let me approve a loan?",
    a: "Either the borrower's KYC pack is incomplete (check the KYC checklist on the loan detail page — the product's required-docs union with the base set must all be VERIFIED) or you don't have loans.decide permission.",
  },
  {
    q: "The demand letter Dispatch button is greyed out — why?",
    a: "Per FRD §3.6.5, demand letters must be approved before dispatch — and the drafter can't self-approve. Have someone with collections.dl_approve_company (or dl_approve_legal for attorney variants) approve it first; the Dispatch button becomes available afterwards.",
  },
  {
    q: 'What does the "Posted" badge mean?',
    a: "It means a balanced double-entry journal entry has been written to the GL for that event. Click the badge to inspect the entry — debit and credit lines, source ref, period — and to reverse it if needed.",
  },
  {
    q: "How is DORSI utilization calculated?",
    a: "Aggregate = sum of outstanding principal across ALL active DORSI loans, divided by 15% of Company Total Equity. Individual = the same per single borrower, divided by 30% of the aggregate cap (= 4.5% of equity). If either projected ratio exceeds 1.0 for a proposed new loan, board approval must be recorded before disburse.",
  },
  {
    q: "Can I undo a journal entry?",
    a: 'Yes — open the entry drawer (click any "Posted" badge) and click Reverse. That creates a new entry of the opposite shape; the original is preserved for the audit trail.',
  },
  {
    q: "How do I stop receiving a daily report email I subscribed to?",
    a: "Notifications are queued by the API but actual delivery is through whichever provider env you configured (MOCK by default). Subscription preferences live with your provider account; in production you can also tweak via the cron schedule on /jobs.",
  },
  {
    q: "How do I export all the data for a regulator?",
    a: "Go to /reports and download the relevant CSV (DORSI utilization, demand letters, repossession, etc.). For one-off ad-hoc queries that aren't a predefined report, an admin can use Prisma Studio (`pnpm db:studio`) against the production DB.",
  },
  {
    q: "I tagged a customer as DORSI but the cap math hasn't updated.",
    a: "The utilization endpoint re-computes on every call, so a hard refresh of /compliance/dorsi should reflect the change immediately. If you're still seeing stale numbers, check that the customer has active loans — only DISBURSED / ACTIVE / DEFAULTED loans count toward the cap.",
  },
  {
    q: "What happened to the new-loan dialog?",
    a: "It's been replaced by a full-page 5-step wizard at /loans/new. Each step focuses on one decision (Borrower → Product & Terms → Collateral & Co-makers → Verification → Review), with the smart features (KYC gap warning, affordability, DORSI projection, pre-decisioning preview) inline where they're most useful. Drafts now auto-save on every Next click — visit /loans/drafts to resume.",
  },
  {
    q: "Where are my saved loan drafts?",
    a: 'Click "Drafts (N)" on the /loans page when the button appears (it only shows when you have at least one saved draft), or go to /loans/drafts directly. Drafts are private per officer — you don\'t see other officers\' WIP applications. Each row has "Resume" + "Discard" actions.',
  },
  {
    q: "Does the AI assistant send our customer data to OpenAI?",
    a: 'No. Never. The assistant runs entirely on infrastructure you control — Ollama installed on the host (or a private Ollama deployment you point at). No cloud AI service is contacted. With OLLAMA_URL unset, the assistant returns a "configure Ollama" mock response and writes nothing externally either. Every assistant call is audit-logged with the model id and token count (but NOT the prompt or response body — those are PII-adjacent).',
  },
  {
    q: "How do I turn on the AI assistant?",
    a: 'Two steps. First, install Ollama on the host: https://ollama.com. Then pull a model (one-time, ~2.3 GB): `ollama pull phi3:mini`. Set OLLAMA_URL=http://localhost:11434 in the api environment and restart the api. The assistant panel\'s status badge flips from "Mock · not ready" to "phi3:mini · ready".',
  },
  {
    q: "The face-match score is low — does that mean fraud?",
    a: "Not necessarily. Score below 0.55 means the two photos don't look like the same person to face-api's 128-d face descriptor — common causes are sunglasses, low lighting, age difference between the ID photo and selfie (someone with a 10-year-old driver's license), or motion blur. The score is a fraud SIGNAL, not a fraud verdict. The audit log records every match attempt; investigate further before flagging.",
  },
  {
    q: "OCR pre-filled the wrong values — what do I do?",
    a: 'Just edit them. OCR is ~80% accurate on clean photos but lower on skewed / poorly-lit ones. The "Apply to form" button only writes to EMPTY fields, so your manual edits always win. Click "Show raw OCR text" on the OCR card to see exactly what Tesseract recognized — useful for tuning lighting / angle on tricky IDs.',
  },
  {
    q: "Can I install SmartLoan as a desktop / mobile app?",
    a: 'Yes. On Chrome / Edge / Brave: click the install icon in the address bar (or use our "Install SmartLoan" prompt at bottom-right). On iOS Safari: Share → "Add to Home Screen". Once installed it opens in its own standalone window. When new versions deploy, you\'ll get a "New version available · Reload now" banner — pick your moment to apply (save in-progress work first).',
  },
  {
    q: 'I clicked "Reload now" on the update prompt and lost my work.',
    a: 'Service-worker updates trigger a full page reload. That\'s why the prompt warns "save in-progress work first." The loan wizard auto-saves drafts on every Next click, so if you were partway through, your draft is still at /loans/drafts. For other forms (new customer, KYC submission), the in-memory state is gone — re-enter it.',
  },
  {
    q: "What do the anomaly flags mean? Should I reject the loan?",
    a: "Anomaly flags are statistical signals — they DON'T block submission or reject a loan. They highlight applications that deviate from the product's historical baseline (principal / term / rate ≥2σ from the mean) or hit a domain check (applicant velocity, principal-to-income ratio). Use them as a \"look at this more carefully\" prompt, not a verdict. Medium + high severity flags get an audit-log row on /apply for review later.",
  },
  {
    q: "I'm offline. Can I still work on loans?",
    a: "Briefly, yes. The PWA service worker caches the app shell so you can navigate around already-loaded pages. But financial actions (decide, disburse, payment, etc.) need a live API call — we deliberately don't serve stale balances or audit data. If the network drops mid-action, you'll see a \"you're offline\" page until connection returns.",
  },

  // ── RBAC / delegations ──────────────────────────────────────────────
  {
    q: "How do I bulk-onboard a batch of staff users?",
    a: 'Admin only. Go to /users/bulk (or "Bulk users" in the sidebar). Drop a CSV with columns email, name, password, role (required) and optionally customerId + extraRoles. Click "Dry run" first to validate every row without writing; if everything\'s green, click "Import". Up to 500 rows per batch, partial-success by default — bad rows don\'t block the others. Each successful user gets their own USER_CREATE audit row plus a single BULK_USER_IMPORT summary row for the batch.',
  },
  {
    q: "How do I grant someone a role temporarily — e.g. for two-week acting coverage?",
    a: 'On /users, click "Assign" on the user\'s row. In the dialog, tick "Temporary grant — expires at a set time" at the top, pick a future date/time (defaults to 14 days at 5pm), then click whichever role you want to grant. Their badge will show "until {date}". After that instant, the resolver stops including that role\'s perms automatically — no cleanup needed. To extend, re-assign the same role with a new expiry; to make it permanent, re-assign with the toggle off.',
  },
  {
    q: 'A permission is showing "DRAFT" — what does that mean?',
    a: "DRAFT is a staging state in the permission lifecycle. The permission exists in the catalog and can be added to roles, but the resolver does NOT actually grant it at permission-check time. The use case: wire up role membership BEFORE flipping a new feature on — when you're ready to go live, an admin clicks → ACTIVE in the /roles permission catalog and the perm starts firing for everyone holding it. DEPRECATED is the opposite end: still effective so in-flight flows don't break, but flagged for planned removal.",
  },
  {
    q: "Can one role inherit permissions from another?",
    a: "Yes. On /roles, click the pencil to edit any role. The \"Inherits from\" section is a checklist of every other role in the system — tick the ones whose permissions this role should pick up. Inheritance is transitive (parent of parent counts), and cycles are rejected on save with the offending path. The role's effective permission set at resolve time = its own direct perms ∪ every ancestor's perms. Self isn't selectable.",
  },
  {
    q: 'How do I find out "who currently has permission X" before I remove it?',
    a: 'On /roles, the top panel is "Who has permission…?". Pick a permission from the searchable list and the panel shows every role granting it (with the count of users holding that role) PLUS every active delegation passing it through, with the total deduped user count. That\'s the audit answer to "if I remove this perm, who loses what?". The separate edit-impact dialog that pops up on Save covers the role-side of the same question — it shows users for whom THIS role was the sole grant.',
  },
  {
    q: "The system refused to remove ADMIN from someone — why?",
    a: "Two guards stack here. (1) Self-lockout: you can't remove your own ADMIN — strip your own admin and you'd lose admin.users on the very next request. Ask another admin to do it. (2) Last-admin guard: even removing someone ELSE'S ADMIN is refused if they're the only remaining active admin on the org. The error is 409 Conflict with a message telling you to promote another user to ADMIN first. Both guards count only ACTIVE assignments (user.active = true) and exclude expired temporary grants.",
  },
  {
    q: 'I revoked a delegation but the delegate is still showing as "has the perms" on the preview. Why?',
    a: "Most likely caching. The /delegations page invalidates on revoke, but if the delegate has the page open they'll see stale data until their next refetch (default ~30s). The actual permission check is live — they're not granted the perms in any new API request. If you want them locked out immediately, the revoke already did that server-side. If you want to verify, open the delegation Preview dialog: the isActiveNow field is the source of truth.",
  },
];
