import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SkeletonCard } from '@loan/ui';

import { DashboardShell } from './components/DashboardShell';
import { PortalShell } from './components/PortalShell';
import { useAuth } from './providers/auth';

// Login + Dashboard stay eager — they're the entry points; lazy-loading
// them would only add a flash of the suspense fallback.
import { LoginPage } from './features/auth';
import { DashboardPage } from './features/dashboard';

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
const CustomersPage         = lazyNamed(() => import('./features/customers'), 'CustomersPage');
const CustomerDetailPage    = lazyNamed(() => import('./features/customers'), 'CustomerDetailPage');
const CreditSurveyPage      = lazyNamed(() => import('./features/customers'), 'CreditSurveyPage');
const KycReviewPage         = lazyNamed(() => import('./features/kyc'),       'KycReviewPage');
const LoansListPage         = lazyNamed(() => import('./features/loans'),         'LoansListPage');
const LoanDetailPage        = lazyNamed(() => import('./features/loans'),         'LoanDetailPage');
const LoanProductsPage      = lazyNamed(() => import('./features/loan-products'), 'LoanProductsPage');
const CollectionsPage       = lazyNamed(() => import('./features/collections'), 'CollectionsPage');
const BulkPaymentsPage      = lazyNamed(() => import('./features/payments'),    'BulkPaymentsPage');

const AccountingDashboardPage = lazyNamed(() => import('./features/accounting'), 'AccountingDashboardPage');
const AnalyticsPage           = lazyNamed(() => import('./features/accounting'), 'AnalyticsPage');
const BalanceSheetPage        = lazyNamed(() => import('./features/accounting'), 'BalanceSheetPage');
const ChartOfAccountsPage     = lazyNamed(() => import('./features/accounting'), 'ChartOfAccountsPage');
const IncomeStatementPage     = lazyNamed(() => import('./features/accounting'), 'IncomeStatementPage');
const JournalEntriesPage      = lazyNamed(() => import('./features/accounting'), 'JournalEntriesPage');
const LoanPortfolioPage       = lazyNamed(() => import('./features/accounting'), 'LoanPortfolioPage');
const PeriodsPage             = lazyNamed(() => import('./features/accounting'), 'PeriodsPage');
const TrialBalancePage        = lazyNamed(() => import('./features/accounting'), 'TrialBalancePage');

const DecisionRulesPage = lazyNamed(() => import('./features/decisioning'),   'DecisionRulesPage');
const EclRunsPage       = lazyNamed(() => import('./features/ecl'),           'EclRunsPage');
const BankStatementsPage = lazyNamed(() => import('./features/reconciliation'), 'BankStatementsPage');
const StatementDetailPage = lazyNamed(() => import('./features/reconciliation'), 'StatementDetailPage');
const CooperativePage    = lazyNamed(() => import('./features/cooperative'),    'CooperativePage');
const ScreeningPage     = lazyNamed(() => import('./features/screening'),     'ScreeningPage');
const NotificationsPage = lazyNamed(() => import('./features/notifications'), 'NotificationsPage');
const JobsPage          = lazyNamed(() => import('./features/jobs'),          'JobsPage');
const RolesPage         = lazyNamed(() => import('./features/rbac'),          'RolesPage');
const UsersPage         = lazyNamed(() => import('./features/rbac'),          'UsersPage');
const DelegationsPage   = lazyNamed(() => import('./features/delegations'),   'DelegationsPage');
const ProfilePage       = lazyNamed(() => import('./features/profile'),       'ProfilePage');
const SettingsPage      = lazyNamed(() => import('./features/profile'),       'SettingsPage');

// Customer portal — also lazy. A staff user never loads these chunks.
const PortalApply      = lazyNamed(() => import('./features/portal'), 'PortalApply');
const PortalDashboard  = lazyNamed(() => import('./features/portal'), 'PortalDashboard');
const PortalKyc        = lazyNamed(() => import('./features/portal'), 'PortalKyc');
const PortalLoanDetail = lazyNamed(() => import('./features/portal'), 'PortalLoanDetail');
const PortalLoans      = lazyNamed(() => import('./features/portal'), 'PortalLoans');

/** Fallback used while a route's chunk is fetching. */
function RouteFallback() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <SkeletonCard />
    </div>
  );
}

export function App() {
  const { token, user } = useAuth();

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // CUSTOMER role gets the borrower portal; everyone else gets the officer console.
  if (user?.role === 'CUSTOMER') {
    return (
      <PortalShell>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/portal" element={<PortalDashboard />} />
            <Route path="/portal/apply" element={<PortalApply />} />
            <Route path="/portal/loans" element={<PortalLoans />} />
            <Route path="/portal/loans/:id" element={<PortalLoanDetail />} />
            <Route path="/portal/kyc" element={<PortalKyc />} />
            <Route path="*" element={<Navigate to="/portal" replace />} />
          </Routes>
        </Suspense>
      </PortalShell>
    );
  }

  return (
    <DashboardShell>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route path="/customers/:id/survey" element={<CreditSurveyPage />} />
          <Route path="/loans" element={<LoansListPage />} />
          <Route path="/loans/:id" element={<LoanDetailPage />} />
          <Route path="/loan-products" element={<LoanProductsPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/payments/bulk" element={<BulkPaymentsPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/decision-rules" element={<DecisionRulesPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/users" element={<UsersPage />} />
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
          <Route path="/accounting/trial-balance" element={<TrialBalancePage />} />
          <Route path="/accounting/income-statement" element={<IncomeStatementPage />} />
          <Route path="/accounting/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="/accounting/portfolio" element={<LoanPortfolioPage />} />
          <Route path="/accounting/periods" element={<PeriodsPage />} />
          <Route path="/accounting/ecl" element={<EclRunsPage />} />
          <Route path="/reconciliation" element={<BankStatementsPage />} />
          <Route path="/reconciliation/:id" element={<StatementDetailPage />} />
          <Route path="/cooperative" element={<CooperativePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </DashboardShell>
  );
}
