# SmartLoan — Packages

Per-package contract. Use this when you need to know **what a package
owns**, **what it depends on**, and **what it exports** without grepping
the codebase.

For request-flow diagrams see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## apps/api · `@loan/api`

**Owns** · The HTTP surface. Fastify 5 + plugins, all routes under
`/api/v1`.

**Routes**

| Path                                   | Method    | Auth                 | Notes                                   |
| -------------------------------------- | --------- | -------------------- | --------------------------------------- |
| `/auth/login`                          | POST      | public               | Returns `{ token, user }`               |
| `/auth/register`                       | POST      | public               | Self-signup as `CUSTOMER`               |
| `/auth/me`                             | GET       | bearer               | Current user                            |
| `/customers`                           | GET/POST  | bearer               | List / create                           |
| `/customers/:id`                       | GET/PATCH | bearer               | Detail / update                         |
| `/kyc`                                 | GET/POST  | bearer               | List per `?customerId`, submit doc      |
| `/kyc/:id/decide`                      | POST      | LOAN_OFFICER+        | Approve / reject one doc                |
| `/kyc/customers/:id/status`            | GET       | bearer               | Rollup status                           |
| `/scoring/survey/questions`            | GET       | bearer               | Question catalog                        |
| `/scoring/survey/submit`               | POST      | bearer               | Compute + persist                       |
| `/scoring/customers/:id/score`         | GET       | bearer               | Latest snapshot                         |
| `/scoring/tier`                        | GET       | bearer               | Tier metadata lookup                    |
| `/loans`                               | GET       | bearer               | List                                    |
| `/loans/quote`                         | POST      | bearer               | Pre-apply amortization preview          |
| `/loans/apply`                         | POST      | bearer               | Snapshot score + insert                 |
| `/loans/:id`                           | GET       | bearer               | Detail incl. schedule                   |
| `/loans/:id/decide`                    | POST      | LOAN_OFFICER+        | APPROVE / REJECT                        |
| `/loans/:id/disburse`                  | POST      | LOAN_OFFICER+        | Materialize schedule                    |
| `/loans/:id/payments`                  | POST      | ACCOUNTANT+          | Record + apply payment                  |
| `/accounting/accounts`                 | GET       | bearer               | Chart of accounts                       |
| `/accounting/accounts`                 | POST      | ADMIN/ACCOUNTANT     | Create account                          |
| `/accounting/accounts/seed`            | POST      | ADMIN                | Idempotent default chart upsert         |
| `/accounting/journal`                  | GET/POST  | bearer / ACCOUNTANT+ | List + post manual entries              |
| `/accounting/journal/:id`              | GET       | bearer               | Entry detail incl. lines                |
| `/accounting/ledger/:accountId`        | GET       | bearer               | Per-account ledger with running balance |
| `/accounting/reports/trial-balance`    | GET       | bearer               | Trial balance as-of date                |
| `/accounting/reports/income-statement` | GET       | bearer               | P&L for `from..to`                      |
| `/accounting/reports/balance-sheet`    | GET       | bearer               | Balance sheet as-of date                |
| `/accounting/reports/loan-portfolio`   | GET       | bearer               | Aging buckets + outstanding             |

**Deps** · `@loan/db`, `@loan/auth`, `@loan/credit-scoring`,
`@loan/loans`, `@loan/kyc`, `@loan/accounting`, `@loan/shared-types`,
`fastify`, `@fastify/jwt`, `@fastify/cors`, `@fastify/helmet`,
`@fastify/multipart`, `@fastify/static`, `@fastify/swagger`, `zod`.

---

## apps/web · `@loan/web`

**Owns** · The React + Vite officer console. Pages live under
`src/pages/`, the side-nav shell under `src/components/DashboardShell.tsx`.

**Routes**

| Path                           | Page                    | Roles               |
| ------------------------------ | ----------------------- | ------------------- |
| `/`                            | DashboardPage           | all                 |
| `/customers`                   | CustomersPage           | all                 |
| `/customers/:id`               | CustomerDetailPage      | all                 |
| `/customers/:id/survey`        | CreditSurveyPage        | all                 |
| `/loans`                       | LoansPage               | all                 |
| `/loans/:id`                   | LoanDetailPage          | all                 |
| `/kyc`                         | KycReviewPage           | ADMIN, LOAN_OFFICER |
| `/accounting`                  | AccountingDashboardPage | ADMIN, ACCOUNTANT   |
| `/accounting/accounts`         | ChartOfAccountsPage     | ADMIN, ACCOUNTANT   |
| `/accounting/journal`          | JournalEntriesPage      | ADMIN, ACCOUNTANT   |
| `/accounting/trial-balance`    | TrialBalancePage        | ADMIN, ACCOUNTANT   |
| `/accounting/income-statement` | IncomeStatementPage     | ADMIN, ACCOUNTANT   |
| `/accounting/balance-sheet`    | BalanceSheetPage        | ADMIN, ACCOUNTANT   |
| `/accounting/portfolio`        | LoanPortfolioPage       | ADMIN, ACCOUNTANT   |
| `/login`                       | LoginPage               | public              |

Dev proxies `/api` and `/uploads` to `http://localhost:3001`.

**Deps** · `@loan/api-client`, `@loan/ui`, `@loan/shared-types`,
`@loan/shared-utils`, `@loan/credit-scoring`, `@loan/loans`,
`@loan/features`, `@tanstack/react-query`, `react`, `react-router-dom`,
`lucide-react`, `tailwindcss`.

---

## libs/db · `@loan/db`

**Owns** · `prisma/schema.prisma`, generated client, repositories, seed
script.

**Schema highlights**

- `User` (role: ADMIN / LOAN_OFFICER / ACCOUNTANT / CUSTOMER)
- `Customer` (full underwriting profile)
- `KycSubmission` (one row per uploaded document)
- `CreditScore` (immutable snapshots, never updated in place)
- `SurveyResponse` (raw answers that produced a score)
- `LoanApplication` (status enum, snapshotted `creditScoreAtApply` /
  `tierAtApply`)
- `LoanSchedule` (one row per installment)
- `LoanPayment` (one row per money-in event)
- `Account` (chart of accounts; system flag for protected codes)
- `JournalEntry` + `JournalLine` (append-only double-entry ledger)

**Exports**

- `prisma` — singleton client
- `fastifyPrisma` — plugin that decorates `app.prisma`
- Repositories: `customerRepository`, `kycRepository`,
  `creditScoreRepository`, `surveyRepository`, `loanRepository`,
  `accountingRepository`

**Scripts** (via `pnpm --filter @loan/db <name>`):
`prisma:migrate`, `prisma:generate`, `prisma:seed`, `prisma:studio`.

---

## libs/credit-scoring · `@loan/credit-scoring`

**Owns** · The scoring engine. Pure functions, no I/O.

**Factor catalog** (`factors.ts`) — survey factors total 100 weighted
points, behavior factors total 50:

| Factor         | Source   | Max | Notes                             |
| -------------- | -------- | --- | --------------------------------- |
| `income`       | survey   | 25  | Monthly income tier               |
| `employment`   | survey   | 15  | Stability + tenure                |
| `debt_ratio`   | survey   | 15  | Reverse-scored                    |
| `housing`      | survey   | 10  | Own / rent / live-in              |
| `dependents`   | survey   | 5   | Reverse-scored                    |
| `education`    | survey   | 10  | Highest attainment                |
| `savings`      | survey   | 20  | Liquid buffer in months           |
| `prior_loans`  | behavior | 15  | Count, capped                     |
| `defaults`     | behavior | 15  | Reverse-scored                    |
| `on_time_rate` | behavior | 20  | % installments paid on/before due |

**Exports**

- `FACTORS`, `SURVEY_QUESTIONS`
- `computeCreditScore({ answers, behavior }) → CreditScoreResult`
- `toTier(score) → CreditTier` ('A'|'B'|'C'|'D'|'F')

---

## libs/loans · `@loan/loans`

**Owns** · Amortization math.

```ts
monthlyPayment(principal, annualRate, termMonths) → number
computeAmortization({ principal, annualRate, termMonths }) → AmortizationRow[]
```

Fixed-payment amortization. Penny-rounding drift is absorbed by the
final installment so the closing balance is exactly `0`.

---

## libs/accounting · `@loan/accounting`

**Owns** · The general ledger. Pure functions, no I/O.

**Chart of accounts** (`chart.ts`) — system codes referenced by auto-posting:

| Code   | Account                         | Type    | Normal |
| ------ | ------------------------------- | ------- | ------ |
| `1000` | Cash                            | ASSET   | DEBIT  |
| `1100` | Loans Receivable                | ASSET   | DEBIT  |
| `1190` | Allowance for Doubtful Accounts | ASSET   | CREDIT |
| `1200` | Interest Receivable             | ASSET   | DEBIT  |
| `3000` | Owner's Equity                  | EQUITY  | CREDIT |
| `4000` | Interest Income                 | INCOME  | CREDIT |
| `4100` | Fee Income                      | INCOME  | CREDIT |
| `5000` | Bad Debt Expense                | EXPENSE | DEBIT  |
| `5100` | Operating Expense               | EXPENSE | DEBIT  |

**Auto-posting** (`posting.ts`):

- `loanDisbursementEntry`: Dr Loans Receivable / Cr Cash
- `loanPaymentEntry`: Dr Cash / Cr Interest Income / Cr Loans Receivable
- `allocatePayment` splits the cash across the unpaid installments
  (interest first, then principal) using the schedule
- `buildEntry` validates that every entry balances

**Reports** (`reports.ts`):

- `buildTrialBalance`
- `buildIncomeStatement`
- `buildBalanceSheet` (computes retained earnings from income/expense)
- `buildAgingReport` (CURRENT / 1–30 / 31–60 / 61–90 / 90+)

Persistence lives in `@loan/db → AccountingRepository`, which resolves
account codes, allocates `JE-YYYY-NNNNNN` numbers, and posts entries
inside transactions. `postIfAbsent(source, sourceRefId)` makes the
disburse/payment auto-posts idempotent.

---

## libs/kyc · `@loan/kyc`

**Owns** · The rollup rule from per-document statuses to
per-customer status.

```ts
REQUIRED_DOCS = ['ID_FRONT', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS']
validateKyc(submissions) → { complete, status, missing, rejected }
```

Used by both the API (to recompute on each decision) and the web
(to show "still missing: PROOF_OF_INCOME" hints).

---

## libs/auth · `@loan/auth`

**Owns** · Password hashing + Fastify auth plugin.

**Exports**

- `hashPassword(plain) → string` — Argon2id, `memoryCost: 19_456`,
  `timeCost: 2`
- `verifyPassword(plain, hash) → boolean`
- `fastifyAuth` — plugin that decorates:
  - `app.authenticate` — verifies JWT, hangs `request.user` on the request
  - `app.requireRole(...roles)` — composes on top of `authenticate`

Types: `UserRole`, `JwtPayload`. The request augmentation is exported
from `@loan/auth` so the API package doesn't need its own type
augmentation file.

---

## libs/api-client · `@loan/api-client`

**Owns** · A thin fetch wrapper + TanStack Query hooks. Browser-only.

**Singleton pattern**: configure once at startup with the token
getter; every hook reads from `getApiClient()`. No prop drilling.

**Hooks**

- `useLogin`, `useRegister`, `useMyProfile`
- `useCustomers`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`
- `useKycForCustomer`, `useKycStatus`, `useSubmitKyc`, `useDecideKyc`
- `useSurveyQuestions`, `useCustomerScore`, `useSubmitSurvey`
- `useLoans`, `useLoan`, `useQuote`, `useApplyLoan`, `useDecideLoan`,
  `useDisburseLoan`, `useRecordPayment`

**ApiError**: server-supplied `message` is surfaced to the UI so users
see "Invalid credentials" instead of "API 401".

---

## libs/shared-types · `@loan/shared-types`

**Owns** · All transport types shared between the api and the web.

Anything that lands in a JSON payload should be typed here, not
redeclared in either app. Decimal-style numbers from Prisma are typed
as `string | number` because Prisma returns `Decimal` as a string by
default — every consumer that does math should `Number(…)` first.

---

## libs/shared-utils · `@loan/shared-utils`

**Owns** · Tiny pure helpers — `formatMoney`, `formatPercent`,
`formatDate`, `formatDateTime`, `clamp`, `isEmail`. All locale-aware
(`en-PH`) and PHP-denominated by default.

---

## libs/features · `@loan/features`

**Owns** · The feature-flag registry.

```ts
FEATURES['credit_scoring.behavior_signals']
isFeatureOn(key, overrides?)
```

Flags ship default-on/off in code; the API can override per-request
when the future admin feature-flags page is built.

---

## libs/ui · `@loan/ui`

**Owns** · The shadcn-flavored React component library. Tailwind +
Radix + lucide. Dark theme by default with glass surfaces and a themed
scrollbar.

**Exports**

- `Button`, `Card` (Card/Header/Title/Description/Content/Footer)
- `Dialog` (open via state, never on backdrop click)
- `Input`, `Label`, `Badge`
- `DropdownMenu` (Trigger/Content/Item/Label/Separator)
- `SkeletonCard`, `SkeletonLine`
- `Toaster`, `useToast` — toasts auto-close after 5 s
- `cn(...classes)` — `clsx + tailwind-merge`

CSS entry: `@loan/ui/globals.css`. Apps that consume the UI lib import
it once from the app's own `index.css`.
