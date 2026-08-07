import { lazy, Suspense, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { SkeletonCard } from "@loan/ui";

import { DashboardShell } from "./components/DashboardShell";
import { PortalShell } from "./components/PortalShell";
import { useAuth } from "./providers/auth";

// Login + Dashboard stay eager — they're the entry points; lazy-loading
// them would only add a flash of the suspense fallback. Register sits
// next to Login for the same reason: it's the other front door.
import { CompleteProfilePage, LoginPage, RegisterPage } from "./features/auth";
// Eager, not lazy: these are what the app falls back to when something
// has already gone wrong, and a fallback that needs a chunk to load is
// no fallback on a flaky connection.
import { NotFoundPage, ServerErrorPage } from "./features/errors";
import { DashboardPage } from "./features/dashboard";

/**
 * Wrap a named export so `React.lazy` (which expects a default export) is
 * happy. `lazyNamed(() => import('./features/loans'), 'LoansListPage')` is
 * the equivalent of `import { LoansListPage } from './features/loans'`.
 */
function lazyNamed<Mod, K extends keyof Mod>(
  loader: () => Promise<Mod>,
  name: K,
): ComponentType {
  return lazy(async () => {
    const mod = await loader();
    return { default: mod[name] as unknown as ComponentType };
  });
}

// Staff console — lazy. Each chunk only loads when its route is visited.
const CustomersPage = lazyNamed(
  () => import("./features/customers"),
  "CustomersPage",
);
const CustomerDetailPage = lazyNamed(
  () => import("./features/customers"),
  "CustomerDetailPage",
);
const CreditSurveyPage = lazyNamed(
  () => import("./features/customers"),
  "CreditSurveyPage",
);
const BulkCustomersPage = lazyNamed(
  () => import("./features/customers"),
  "BulkCustomersPage",
);
const KycReviewPage = lazyNamed(
  () => import("./features/kyc"),
  "KycReviewPage",
);
const LoansListPage = lazyNamed(
  () => import("./features/loans"),
  "LoansListPage",
);
const LoanDetailPage = lazyNamed(
  () => import("./features/loans"),
  "LoanDetailPage",
);
const NewLoanPage = lazyNamed(() => import("./features/loans"), "NewLoanPage");
const PreAssessmentsPage = lazyNamed(
  () => import("./features/pre-assessment"),
  "PreAssessmentsPage",
);
const AgentsPage = lazyNamed(() => import("./features/agents"), "AgentsPage");
const MyBookPage = lazyNamed(() => import("./features/agents"), "MyBookPage");
const LoanDraftsPage = lazyNamed(
  () => import("./features/loans"),
  "LoanDraftsPage",
);
const LoanProductsPage = lazyNamed(
  () => import("./features/loan-products"),
  "LoanProductsPage",
);
const CollectionsPage = lazyNamed(
  () => import("./features/collections"),
  "CollectionsPage",
);
const MyAccountsPage = lazyNamed(
  () => import("./features/collections"),
  "MyAccountsPage",
);
const DemandLettersPage = lazyNamed(
  () => import("./features/collections"),
  "DemandLettersPage",
);
const RepossessionPage = lazyNamed(
  () => import("./features/repossession"),
  "RepossessionPage",
);
const LeaseQueuePage = lazyNamed(
  () => import("./features/lease"),
  "LeaseQueuePage",
);
const DorsiPage = lazyNamed(() => import("./features/dorsi"), "DorsiPage");
const ReportsPage = lazyNamed(
  () => import("./features/reports"),
  "ReportsPage",
);
const HelpPage = lazyNamed(() => import("./features/help"), "HelpPage");
const BulkPaymentsPage = lazyNamed(
  () => import("./features/payments"),
  "BulkPaymentsPage",
);
const PaymentsConsolePage = lazyNamed(
  () => import("./features/payments"),
  "PaymentsConsolePage",
);

const AccountingDashboardPage = lazyNamed(
  () => import("./features/accounting"),
  "AccountingDashboardPage",
);
const AnalyticsPage = lazyNamed(
  () => import("./features/accounting"),
  "AnalyticsPage",
);
const BalanceSheetPage = lazyNamed(
  () => import("./features/accounting"),
  "BalanceSheetPage",
);
const ChartOfAccountsPage = lazyNamed(
  () => import("./features/accounting"),
  "ChartOfAccountsPage",
);
const IncomeStatementPage = lazyNamed(
  () => import("./features/accounting"),
  "IncomeStatementPage",
);
const JournalEntriesPage = lazyNamed(
  () => import("./features/accounting"),
  "JournalEntriesPage",
);
const LoanPortfolioPage = lazyNamed(
  () => import("./features/accounting"),
  "LoanPortfolioPage",
);
const PeriodsPage = lazyNamed(
  () => import("./features/accounting"),
  "PeriodsPage",
);
const TrialBalancePage = lazyNamed(
  () => import("./features/accounting"),
  "TrialBalancePage",
);

const ForgotPasswordPage = lazyNamed(
  () => import("./features/auth/pages/ForgotPassword"),
  "ForgotPasswordPage",
);
const ResetPasswordPage = lazyNamed(
  () => import("./features/auth/pages/ResetPassword"),
  "ResetPasswordPage",
);
const CoMakerConsentPage = lazyNamed(
  () => import("./features/co-maker"),
  "CoMakerConsentPage",
);
const QuestionnairesPage = lazyNamed(
  () => import("./features/questionnaires"),
  "QuestionnairesPage",
);
const DecisionRulesPage = lazyNamed(
  () => import("./features/decisioning"),
  "DecisionRulesPage",
);
const EclRunsPage = lazyNamed(() => import("./features/ecl"), "EclRunsPage");
const BankStatementsPage = lazyNamed(
  () => import("./features/reconciliation"),
  "BankStatementsPage",
);
const StatementDetailPage = lazyNamed(
  () => import("./features/reconciliation"),
  "StatementDetailPage",
);
const CooperativePage = lazyNamed(
  () => import("./features/cooperative"),
  "CooperativePage",
);
const AnnualDocsDashboardPage = lazyNamed(
  () => import("./features/compliance"),
  "AnnualDocsDashboard",
);
const ScreeningPage = lazyNamed(
  () => import("./features/screening"),
  "ScreeningPage",
);
const NotificationsPage = lazyNamed(
  () => import("./features/notifications"),
  "NotificationsPage",
);
const JobsPage = lazyNamed(() => import("./features/jobs"), "JobsPage");
const RolesPage = lazyNamed(() => import("./features/rbac"), "RolesPage");
const UsersPage = lazyNamed(() => import("./features/rbac"), "UsersPage");
const BulkUsersPage = lazyNamed(
  () => import("./features/rbac"),
  "BulkUsersPage",
);
const DelegationsPage = lazyNamed(
  () => import("./features/delegations"),
  "DelegationsPage",
);
const ProfilePage = lazyNamed(
  () => import("./features/profile"),
  "ProfilePage",
);
const SettingsPage = lazyNamed(
  () => import("./features/profile"),
  "SettingsPage",
);

// Customer portal — also lazy. A staff user never loads these chunks.
const PortalApply = lazyNamed(() => import("./features/portal"), "PortalApply");
const PortalDashboard = lazyNamed(
  () => import("./features/portal"),
  "PortalDashboard",
);
const PortalKyc = lazyNamed(() => import("./features/portal"), "PortalKyc");
const PortalPreAssess = lazyNamed(
  () => import("./features/portal"),
  "PortalPreAssess",
);
const PortalLoanDetail = lazyNamed(
  () => import("./features/portal"),
  "PortalLoanDetail",
);
const PortalLoans = lazyNamed(() => import("./features/portal"), "PortalLoans");
const PortalSavings = lazyNamed(
  () => import("./features/portal"),
  "PortalSavings",
);
const PortalContributions = lazyNamed(
  () => import("./features/portal"),
  "PortalContributions",
);
const PortalProfile = lazyNamed(
  () => import("./features/portal"),
  "PortalProfile",
);
const PortalLedger = lazyNamed(
  () => import("./features/portal"),
  "PortalLedgerPage",
);

/** Fallback used while a route's chunk is fetching. */
function RouteFallback() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <SkeletonCard />
    </div>
  );
}

/*
 * The two shells, as layout routes.
 *
 * They used to wrap <Routes> directly — `<Shell><Routes>…</Routes></Shell>`
 * — which works fine right up until a route needs to render WITHOUT the
 * chrome. The error pages do: a 404 nested inside the shell appeared in
 * the content column with the rail and header still around it, and its
 * `min-h-screen` measured the whole viewport while sitting in a column
 * already 56px shorter, so it overflowed as well as looking wrong.
 *
 * As layout routes, the shell is applied per-route instead of to
 * everything, and anything declared as a sibling gets the bare window.
 * The Suspense boundary moves in here with them so a lazy chunk still
 * shows the skeleton inside the chrome rather than replacing it.
 */
function ConsoleLayout() {
  return (
    <DashboardShell>
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    </DashboardShell>
  );
}

function PortalLayout() {
  return (
    <PortalShell>
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    </PortalShell>
  );
}

export function App() {
  const { token, user } = useAuth();
  const { pathname } = useLocation();

  // Co-maker consent is reached from an invite link by someone with no
  // account, so it sits ahead of the auth check and outside both
  // shells. Ahead of it rather than inside the signed-out branch
  // because an officer with a session open must be able to follow the
  // link too — to check what their co-maker sees, if nothing else.
  if (pathname.startsWith("/co-maker/")) {
    return (
      <Suspense fallback={<SkeletonCard />}>
        <Routes>
          <Route path="/co-maker/:token" element={<CoMakerConsentPage />} />
        </Routes>
      </Suspense>
    );
  }

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        {/*
          Stays a redirect, unlike the two authenticated catch-alls
          below. Out here we can't tell a typo from a real deep link
          into the app — none of those routes are registered in this
          branch — so a signed-out reader hitting /loans/123 must be
          sent to sign in, not told the page doesn't exist. It does.
        */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  /**
   * A borrower who registered but never finished the profile step has
   * no linked Customer row, and every portal endpoint refuses such an
   * account. Render the profile form *instead of* the portal rather
   * than letting them in to meet a wall of failed requests.
   *
   * No <Routes> here on purpose — there is nowhere else to go until
   * this is done, so any URL they type resolves to the same form.
   */
  if (user?.role === "CUSTOMER" && !user.customerId) {
    return <CompleteProfilePage />;
  }

  // CUSTOMER role gets the borrower portal; everyone else gets the officer console.
  if (user?.role === "CUSTOMER") {
    return (
      <Routes>
        {/* Layout route, for the same reason as the console below. */}
        <Route element={<PortalLayout />}>
          <Route path="/portal" element={<PortalDashboard />} />
          <Route path="/portal/pre-assess" element={<PortalPreAssess />} />
          <Route path="/portal/apply" element={<PortalApply />} />
          <Route path="/portal/loans" element={<PortalLoans />} />
          <Route path="/portal/savings" element={<PortalSavings />} />
          <Route
            path="/portal/contributions"
            element={<PortalContributions />}
          />
          <Route path="/portal/ledger" element={<PortalLedger />} />
          <Route path="/portal/profile" element={<PortalProfile />} />
          <Route path="/portal/loans/:id" element={<PortalLoanDetail />} />
          <Route path="/portal/kyc" element={<PortalKyc />} />
        </Route>

        <Route path="/500" element={<ServerErrorPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/*
        The shell is a LAYOUT route rather than a wrapper around
        <Routes>, so the error pages below can sit OUTSIDE it. Nested
        inside, a 404 rendered in the content column with the rail and
        header still around it — and its `min-h-screen` measured the
        whole viewport while sitting in a column already 56px shorter,
        so it overflowed as well as looking wrong. These pages are meant
        to take the window.
      */}
      <Route element={<ConsoleLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        {/* Bulk import comes before /:id so the static segment matches first. */}
        <Route path="/customers/bulk" element={<BulkCustomersPage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/customers/:id/survey" element={<CreditSurveyPage />} />
        <Route path="/loans" element={<LoansListPage />} />
        {/* Wizard pages come before /:id so the static segments match first. */}
        <Route path="/loans/drafts" element={<LoanDraftsPage />} />
        <Route path="/loans/new" element={<NewLoanPage />} />
        <Route path="/loans/new/:draftId" element={<NewLoanPage />} />
        <Route path="/loans/:id" element={<LoanDetailPage />} />
        <Route path="/pre-assessments" element={<PreAssessmentsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        {/*
          An agent's own book. Its own route rather than /agents/:id
          because it takes no id at all — the server resolves the agent
          from the token, which is what stops one agent reading another's
          earnings by editing the address bar.
        */}
        <Route path="/my-book" element={<MyBookPage />} />
        <Route path="/loan-products" element={<LoanProductsPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/collections/my-accounts" element={<MyAccountsPage />} />
        <Route
          path="/collections/demand-letters"
          element={<DemandLettersPage />}
        />
        <Route path="/repossession" element={<RepossessionPage />} />
        <Route path="/lease" element={<LeaseQueuePage />} />
        <Route path="/compliance/dorsi" element={<DorsiPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/payments" element={<PaymentsConsolePage />} />
        <Route path="/payments/bulk" element={<BulkPaymentsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/questionnaires" element={<QuestionnairesPage />} />
        <Route path="/decision-rules" element={<DecisionRulesPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/users" element={<UsersPage />} />
        {/* Bulk import comes after the static segment so it doesn't shadow */}
        <Route path="/users/bulk" element={<BulkUsersPage />} />
        <Route path="/delegations" element={<DelegationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/screening" element={<ScreeningPage />} />
        <Route path="/accounting/analytics" element={<AnalyticsPage />} />
        <Route path="/kyc" element={<KycReviewPage />} />
        <Route path="/accounting" element={<AccountingDashboardPage />} />
        <Route path="/accounting/accounts" element={<ChartOfAccountsPage />} />
        <Route path="/accounting/journal" element={<JournalEntriesPage />} />
        <Route
          path="/accounting/trial-balance"
          element={<TrialBalancePage />}
        />
        <Route
          path="/accounting/income-statement"
          element={<IncomeStatementPage />}
        />
        <Route
          path="/accounting/balance-sheet"
          element={<BalanceSheetPage />}
        />
        <Route path="/accounting/portfolio" element={<LoanPortfolioPage />} />
        <Route path="/accounting/periods" element={<PeriodsPage />} />
        <Route path="/accounting/ecl" element={<EclRunsPage />} />
        <Route path="/reconciliation" element={<BankStatementsPage />} />
        <Route path="/reconciliation/:id" element={<StatementDetailPage />} />
        <Route path="/cooperative" element={<CooperativePage />} />
        <Route
          path="/compliance/annual-docs"
          element={<AnnualDocsDashboardPage />}
        />
      </Route>

      {/* Outside the layout — full page, no rail, no header. */}
      <Route path="/500" element={<ServerErrorPage />} />
      {/*
        A page, not a redirect. Bouncing an unknown path to the
        dashboard meant a stale bookmark or a bad link looked like the
        app losing the reader's place, and nobody ever reported the
        broken link because nobody could tell there was one.
      */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
