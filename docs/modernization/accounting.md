# Accounting

Double-entry general ledger. Living reference; findings are in
`financial-engine-audit.md`.

---

## Flow

```
Loan / coop event
    ↓  posting.ts builds a balanced JournalEntryInput
    ↓  buildEntry validates: no negatives, no both-sides, ≥2 lines, debits == credits
    ↓  postIfAbsent — idempotent on (source, sourceRefType, sourceRefId)
    ↓
JournalEntry + JournalLine
    ↓  period resolved from entryDate; CLOSED periods refuse
    ↓
Trial balance → Income statement / Balance sheet / Aging
```

Every posting carries `source`, `sourceRefType` and `sourceRefId`, so every
financial event is traceable back to the row that caused it — §33's "every
financial event must have an accounting reference".

## Entry builders

20 builders in `libs/accounting/src/posting.ts`, all asserted balanced across
the amount range in `invariants.test.ts`:

| Event                                                                        | Entry                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Disbursement                                                                 | Dr Loans Receivable / Cr Cash + Cr Fee Income                                              |
| Payment                                                                      | Dr Cash / Cr Loans Receivable + Cr Interest Income (+ Cr Customer Advances on overpayment) |
| Interest accrual                                                             | Dr Interest Receivable / Cr Interest Income                                                |
| Late-fee accrual                                                             | Dr Loans Receivable / Cr Fee Income                                                        |
| Penalty waive                                                                | Dr Fee Income / Cr Loans Receivable                                                        |
| Pre-termination fee                                                          | Dr Cash / Cr Fee Income                                                                    |
| Agent commission                                                             | Dr Commission Expense / Cr Agent Payable                                                   |
| Agent payout                                                                 | Dr Agent Payable / Cr Cash                                                                 |
| Repossession auction                                                         | proceeds applied; **surplus → Customer Advances**, deficiency → Bad Debt                   |
| Lease buyout                                                                 | Dr Cash / Cr Other Income                                                                  |
| ECL provision                                                                | Dr Impairment Loss / Cr Allowance (reverses for write-backs)                               |
| Coop: contribution, savings, fund in/out, expense, other income, big brother | per `chart.ts` bucket mapping                                                              |

**The surplus rule is deliberate.** Auction proceeds beyond what the borrower
owes are the borrower's money, not income. They land in Customer Advances
(2100) with a memo saying refundable. Booking them as income would be taking
money that is not the lender's.

## Controls — §34

| Control                           | Status                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| Period close                      | **EXISTS** — posting to a CLOSED period throws `PERIOD_CLOSED`          |
| Period reopen with authorization  | **EXISTS** — permission-gated                                           |
| Journal reversal                  | **EXISTS** — swap-and-link, never delete                                |
| Trial balance                     | **EXISTS** — `/accounting/trial-balance`                                |
| Bank reconciliation               | **EXISTS** — `BankStatement` + line matching                            |
| Unbalanced journal detection      | **EXISTS** — impossible to construct one; `buildEntry` throws           |
| Silent edit prevention            | **EXISTS** — no update path on a posted entry                           |
| **Journal approval**              | **MISSING** — a manual entry posts immediately; §34 lists maker-checker |
| **Subledger ⇄ GL reconciliation** | **MISSING** — no standing assertion (roadmap 2.3)                       |
| **Suspense account monitoring**   | **MISSING**                                                             |

## Idempotency

`postIfAbsent` is backed by `UNIQUE(source, sourceRefType, sourceRefId)`
(migration `20260811120000`). It reads first as a fast path, then attempts the
insert and lets Postgres arbitrate, returning the winner's entry on `P2002`.

Before this, two concurrent callers could both post the same event. Each entry
balanced on its own, so the trial balance still tied and no existing check could
see the duplicate — the reason it is called out as the worst kind of accounting
defect in the audit.

Manual entries (`sourceRefId = NULL`) are exempt, correctly: NULLs are distinct
in a Postgres unique index.

**Before deploying to an environment with history:** run
`libs/db/scripts/detect-duplicate-journal-entries.mjs`. The index cannot be
created while duplicates exist. The remedy for a duplicate is a reversing entry,
not a delete — the script refuses to delete anything and says so.

## IFRS-9 / ECL — §35

`EclRun` records staged provision runs; `eclProvisionEntry` posts the movement
(both directions — a write-back is as real as a charge, asserted in
`invariants.test.ts`).

**Gap:** assumptions (PD, LGD, EAD) are not versioned. §35 asks for configurable
_and versioned_ assumptions, so that a past provision can be explained. Same
class of problem as decision-rule versioning — see `credit-engine.md`.

## Chart of accounts

`DEFAULT_CHART_OF_ACCOUNTS` seeds idempotently (`seedDefaultChart` upserts,
never deletes). Account codes are referenced symbolically via `ACCOUNT_CODES`
rather than as string literals at call sites.

`bucketToAccount` maps cooperative "source of funds" strings to GL codes, with
an unrecognised bucket falling back to Cash (1000). That fallback is worth
knowing about: a typo in a bucket name posts to Cash rather than failing, which
is a silent misclassification. Candidate for tightening to a throw.
