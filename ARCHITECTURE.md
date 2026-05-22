# SmartLoan — Architecture

This document walks through the end-to-end flow: how a request leaves
the browser, hits Fastify, traverses the scoring engine, and gets back
to the React UI with the right type guarantees along the way.

For per-package contracts see **[PACKAGES.md](./PACKAGES.md)**.

---

## High-level shape

```
┌─────────────────┐     /api/v1     ┌──────────────────┐
│   React PWA     │ ───── HTTP ───▶ │    Fastify API   │
│  (apps/web)     │ ◀── JSON ────── │   (apps/api)     │
└─────────────────┘                  └────────┬─────────┘
        ▲                                    │
        │ TanStack Query                     │ Prisma
        │                                    ▼
┌─────────────────┐                  ┌──────────────────┐
│  @loan/api-     │                  │  PostgreSQL 16   │
│  client (hooks) │                  │  (local install) │
└─────────────────┘                  └──────────────────┘
```

Everything is one pnpm workspace driven by Nx. Shared libraries live in
`libs/` and are linked into both sides of the stack via TypeScript path
aliases (no `dist/` indirection during development).

---

## A. The lifecycle of a credit score

The most domain-specific path. Officer opens
`/customers/:id/survey` → the React form pulls factor definitions →
user answers → form posts a flat key/value map → API recomputes →
result is persisted → UI shows the new tier.

### 1. Question catalog (client-side cache)

The factor catalog lives in **`libs/credit-scoring/src/factors.ts`** —
this is the single source of truth for both:

- the **server-side scoring math** (`compute()` walks each factor),
- the **client-side survey UI** (`/scoring/survey/questions` is just a
  JSON projection of `SURVEY_QUESTIONS`).

The web hook **`useSurveyQuestions`** caches that response for an hour
because the catalog only changes on deploy.

### 2. Submitting answers

```ts
useSubmitSurvey().mutateAsync({ customerId, answers });
```

Hits `POST /scoring/survey/submit`. The route handler:

1. Loads any prior loan history for the customer (so behavioral
   signals can fold in).
2. Calls **`computeCreditScore({ answers, behavior })`** — pure
   function, no DB access of its own.
3. Persists a fresh **CreditScore** row + the **SurveyResponse** that
   produced it. Older snapshots are never deleted: we want the audit
   trail of how a score evolved over time.
4. Returns `{ score, tier, breakdown, surveyId }` to the UI.

### 3. The math (`libs/credit-scoring/src/compute.ts`)

For each factor:

```ts
points = clamp(rawPoints(answer), 0, factor.maxPoints) * factor.weight;
```

Survey factors max out at **100 weighted points**. Behavioral factors
add up to **50 more** — but only when the customer actually has loan
history. First-time borrowers get a neutral 50 % of those behavior
points so they aren't punished for the absence of data.

Then we linearly scale into the FICO band:

```
score = 300 + round((totalPoints / maxPoints) * 550)
tier  = toTier(score)            // A ≥ 750, B ≥ 700, C ≥ 600, D ≥ 500, F < 500
```

Score is clamped to `[300, 850]` and stored as an integer.

---

## B. The lifecycle of a KYC submission

1. Customer (or officer on their behalf) uploads a document and posts
   `{ documentType, documentUrl }` to **`POST /kyc`**.
2. A `KycSubmission` row is created with `status = PENDING`.
3. An officer opens `/kyc` (the **`KycReviewPage`**), reviews each
   pending doc, and clicks Approve/Reject.
4. **`useDecideKyc`** calls **`POST /kyc/:id/decide`** which runs
   inside a single transaction:
   - updates the submission's `status`
   - recomputes the **rollup** for the customer using
     `libs/kyc/src/index.ts → validateKyc()`
   - writes the new `kycStatus` back to the customer row
5. The hook invalidates both the per-customer list and the customer's
   status query so the UI snaps to the new state.

The rollup rule is intentionally simple: **all REQUIRED documents
(ID_FRONT, PROOF_OF_INCOME, PROOF_OF_ADDRESS) must be VERIFIED for
the customer to flip to VERIFIED.** Any single REJECTED required doc
flips the rollup to REJECTED; PENDING docs while required ones are
missing keep it at PENDING.

---

## C. The lifecycle of a loan

```
DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → DISBURSED → ACTIVE → CLOSED
                                ↘ REJECTED
                                                          ↘ DEFAULTED
                                                          ↘ CANCELLED
```

### Apply

`POST /loans/apply` does three things, all inside one Prisma
transaction:

1. Looks up the **latest credit score** for the customer and
   **snapshots** `score` + `tier` onto the loan row
   (`creditScoreAtApply` / `tierAtApply`). Future re-scoring never
   changes underwriting history.
2. Generates a human number `LN-2026-000123` from a per-year counter.
3. Inserts the application with `status = SUBMITTED`.

### Decide

`POST /loans/:id/decide` switches the row to `APPROVED` or `REJECTED`.
On rejection, a `decisionReason` is stored for the audit trail.

### Disburse

`POST /loans/:id/disburse` materializes the full amortization
schedule into **LoanSchedule** rows using
`libs/loans/src/index.ts → computeAmortization()` — fixed monthly
payment, with the rounding remainder absorbed by the **final**
installment so the principal is paid down to exactly zero. Status
moves to `DISBURSED → ACTIVE` once the first payment hits.

### Repay

`POST /loans/:id/payments` records a `LoanPayment` and applies the
amount installment-by-installment against the schedule in order. When
the schedule is fully paid the loan is auto-closed (`CLOSED`); when a
payment is missed past tolerance, the status flips to `DEFAULTED`
(and feeds back into the **behavior signal** the scoring engine reads
on the next score recompute — the system is self-correcting).

---

## D. The lifecycle of a journal entry

The general ledger sits beside the loan domain and is touched in two
ways: auto-posted from loan events, or hand-posted by an accountant.

### Auto-posted from loan events

The same Prisma transaction that materializes the schedule or records a
payment also posts the journal entry — books stay consistent with the
domain by construction.

```
disburse(loan):
  Dr Loans Receivable   principal
    Cr Cash             principal

recordPayment(loan, amount):
  allocatePayment splits `amount` across upcoming installments
  (interest first, then principal, in order):
    Dr Cash                       amount
      Cr Interest Income          interestPortion
      Cr Loans Receivable         principalPortion
```

`AccountingRepository.postIfAbsent(source, sourceRefId)` keeps these
idempotent — re-running disburse can't double-book.

### Manual entries

Accountants can post any balanced multi-line entry via `POST
/accounting/journal`. The route validates that debits == credits before
the row hits the DB (`buildEntry` enforces it in the lib too).

### Reports

`/accounting/reports/*` runs the pure aggregators from `@loan/accounting
→ reports.ts` over the raw `JournalLine` table:

- **Trial balance** — net debit/credit per account.
- **Income statement** — `income.total - expense.total` for a range.
- **Balance sheet** — assets vs liabilities + equity, with retained
  earnings folded in from the lifetime income-vs-expense delta.
- **Loan portfolio aging** — buckets unpaid installments into CURRENT
  / 1–30 / 31–60 / 61–90 / 90+ days overdue.

---

## E. Auth flow

JWTs issued by `@fastify/jwt`, signed with `JWT_SECRET`.

1. `POST /auth/login` — credentials in, `{ token, user }` out.
2. The web app stores the token under `loan.auth.token` in
   `localStorage` and the user under `loan.auth.user`.
3. The shared **ApiClient** singleton reads the token via a closure
   so every request automatically picks up the latest value.
4. Server-side, **`libs/auth/src/plugin.ts`** decorates `app.authenticate`
   (verify-token gate) and `app.requireRole(...roles)` (role-gate). Routes
   that need both compose them.

Logout clears localStorage; a `storage` event listener in the
`AuthProvider` triggers signOut in every other tab automatically.

---

## F. Why this shape

- **Same conventions as Click-POS** so anyone fluent in one repo is
  productive in the other. Even the file paths line up.
- **Pure functions for math** (`compute.ts`, `computeAmortization`,
  `validateKyc`). They take plain values in, return plain values out.
  No DB, no network. Unit tests can be exhaustive.
- **Snapshot at decision time.** Scores and tiers are copied onto the
  `LoanApplication` row at apply-time. Re-running the survey six months
  later won't retroactively alter an audit trail.
- **TanStack Query owns server state.** No global stores. Mutations
  invalidate their relevant keys; everything else re-fetches lazily.
- **Repositories live with the schema** (`libs/db/src/repositories/*`)
  rather than next to the routes. Multiple route handlers can call
  the same repository without duplicating Prisma queries.
