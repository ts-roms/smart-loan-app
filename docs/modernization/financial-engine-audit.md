# Financial Engine Audit — P0

This is the document that matters. Everything else in the modernization brief is
architecture; this is the part where being wrong costs money and cannot be
undone by a redeploy.

**Method:** read the actual code paths for posting, payment, disbursement and
accrual. Every claim below cites a file. No behaviour was changed.

---

## Verdict in one line

The **arithmetic** is sound and the **layering** is sound; the **guarantees under
concurrency** are not yet enforced by the database. Three defects share one root
cause: the system checks a condition and then acts on it, without holding
anything that stops a second request doing the same between the two steps.

---

## What is already right (do not "fix" these)

**1. Money types.** 79 `Decimal` columns, every one with explicit precision, zero
floats in any monetary field (`repository-audit.md` §C). This is the defect that
sinks most lending systems and it is simply absent. §11 of the brief needs no work.

**2. Financial operations run inside transactions.** `libs/db/src/repositories/`
uses `$transaction` throughout — `loan.repository.ts` alone in 10 places, plus
cooperative (7), loan-approval (3), kyc, agent, scoring-catalog (2 each),
repossession, lease, customer, collections.

**3. State-machine guards precede financial writes.** `disburse()` refuses unless
`status === "APPROVED"`; `recordPayment()` refuses unless the status is in
`PAYABLE_STATUSES` (throwing a typed `LoanNotPayableError`). These are real
guards, correctly placed _inside_ the transaction.

**4. Reverse-don't-delete is the established idiom.** Journal reversal exists as a
first-class operation; the ledger is treated as append-only. §12 is satisfied in
design.

**5. Idempotent auto-posting exists in concept.** `postIfAbsent` keyed on
`(source, sourceRefType, sourceRefId)` is exactly the right shape — see P0-1 for
why the implementation is not yet load-bearing.

---

## P0-1 — Journal entries can double-post under concurrency

**Severity: P0 (accounting integrity). Confidence: high — read from source.**

`libs/db/src/repositories/accounting.repository.ts`:

```ts
async postIfAbsent(input, opts) {
  const tx = opts.tx ?? this.prisma;
  if (input.sourceRefId) {
    const existing = await tx.journalEntry.findFirst({
      where: { source, sourceRefType, sourceRefId },
    });
    if (existing) return { entry: existing, created: false };
  }
  const entry = await this.postEntry(input, opts);   // ← nothing stops a second caller reaching here
  return { entry, created: true };
}
```

And the schema (`model JournalEntry`) declares:

```prisma
@@index([source, sourceRefId])          // ← index
@@index([sourceRefType, sourceRefId])   // ← index
```

There is **no `@@unique`** on that tuple. So the guard is a read-then-write check
with no database constraint behind it. Two concurrent callers posting the same
source event both find nothing, both post, and the ledger gains a duplicate
entry that balances internally — meaning the trial balance still ties and
nothing screams. That is the worst kind of accounting defect: silent, and
detectable only by reconciling subledger to GL.

**Failure scenario:** the interest-accrual job overlaps with itself (a slow run
plus the next `setInterval` tick — see `libs/jobs`, which has no distributed
lock), or an operator double-submits a payment that auto-posts. Both are
plausible, neither is exotic.

**Fix (P0, small):** add a unique constraint and let the database be the
arbiter, then catch the violation instead of pre-checking:

```prisma
@@unique([source, sourceRefType, sourceRefId], name: "journal_source_ref_unique")
```

Postgres treats NULLs as distinct, so manual entries (`sourceRefId = null`) are
unaffected — no partial index needed. `postIfAbsent` then becomes: attempt the
insert, and on `P2002` re-read and return the existing row. That is the only
version of this function that is correct under concurrency.

**Migration risk:** must check for pre-existing duplicates before adding the
constraint. Ship as: (1) detection query, (2) reconciliation of any hits,
(3) constraint.

---

## P0-2 — Payments have no idempotency key

**Severity: P0 (borrower balance). Confidence: high.**

`model LoanPayment` carries `amount Decimal(14,2)` and a nullable `reference
String?` with **no unique constraint**, and `recordPayment()` performs no
duplicate detection — it validates status, then writes.

A double-submitted form, a retried request after a timeout, or a webhook
delivered twice each create a **second real payment**. The borrower's balance is
then wrong in their favour and the cash never existed. §13 of the brief asks for
exactly this and it is absent.

**Fix (P0):** an `Idempotency-Key` on the payment endpoint, persisted with a
unique constraint (either on the key itself or on `@@unique([loanId, reference])`
where a reference is supplied). Return the _original_ result on a repeat, rather
than erroring — a retry must be safe, not merely rejected.

This same key should cover disbursements and any future provider callbacks
(GCash/Maya/Dragonpay), which are the classic at-least-once delivery sources.

---

## P0-3 — Double disbursement is possible (check-then-act)

**Severity: P0 (cash out the door). Confidence: high on the mechanism.**

`loan.repository.ts` → `disburse()`:

```ts
return this.prisma.$transaction(async (tx) => {
  const loan = await tx.loanApplication.findFirst(...);
  if (!loan) throw new Error("Loan not found");
  if (loan.status !== "APPROVED") throw new Error(`Cannot disburse from status ${loan.status}`);
  ...
  await tx.loanApplication.update({ ... });   // → DISBURSED
```

The guard is inside a transaction, which is right — but Prisma's `$transaction`
runs at PostgreSQL's default **READ COMMITTED**, and there is **no row lock**:

```
grep -rn "FOR UPDATE" libs/db/src apps/api/src   →   (no matches)
```

Two concurrent disbursements therefore both read `APPROVED`, both pass the
guard, and both proceed to post cash movements before either commits.

**Fix (P0, small):** make the transition itself the lock. Either

- `SELECT ... FOR UPDATE` on the loan row before the status check, or
- better, a **conditional update** — `UPDATE ... WHERE id = ? AND status = 'APPROVED'`
  and treat "0 rows affected" as the refusal. This is atomic, needs no explicit
  lock, and expresses the state machine as a database invariant.

The second form is preferable and generalises to every state transition in §24.

---

## P1-4 — No row locking anywhere in the codebase

The `FOR UPDATE` search returning nothing is not only a disbursement problem. Any
read-modify-write over a balance, a schedule allocation, or a running total is
exposed to lost updates under concurrency. P0-1 to P0-3 are the three instances
where the consequence is money; this entry records the systemic version so the
fix is applied as a _pattern_ (conditional updates + unique constraints), not
three one-off patches.

---

## P1-5 — The job scheduler has no distributed lock

`libs/jobs` is an in-process `setInterval` scheduler. With one API process this
is fine and the design note explains the trade-off honestly. With **two**
processes — which is the normal way to get availability — every scheduled job
runs twice, concurrently. Combined with P0-1, an overlapping accrual run is a
duplicate-posting engine.

**This is the constraint to know before scaling horizontally.** Either keep the
API single-process (and say so in the deploy docs), or add a lock —
`pg_try_advisory_lock` is sufficient and needs no Redis.

---

## Reconciliation status

The brief (§10) demands:

```
Loan Balance = Loan Transactions = Payment Allocations = Accounting Entries
```

There is real machinery in this direction — `repair-payment-allocations.ts` and
a sweep script for orphaned journal entries both exist, which means the failure
modes have been met before. What does **not** exist is a _standing_ invariant
check that proves the identity holds. Today the only proof is a manual trial
balance.

**Recommended (P1):** a reconciliation job asserting, per loan and per period:
debits = credits; subledger principal = GL loan receivable; sum of allocations ≤
payment amount; outstanding = disbursed − principal paid ± adjustments. Failures
should raise, not log.

---

## Golden test data — the precondition for §81/§82

The brief forbids changing financial calculations without golden tests, and it is
right to. `libs/loans` is the best-tested library in the repo (6 test files), but
there is no fixed corpus of worked examples per product with a known-good
expected schedule.

**Before any calculation change** (including refactors that "look cleaner"):
freeze a golden set for salary / housing / auto / motorcycle covering principal,
rate, term, frequency, fees, penalties, grace, partial payment, advance payment,
restructure and payoff — with expected output committed. Until that exists, the
correct number of financial-logic changes to make is zero.

---

## Priority summary

| ID   | Finding                                                                  | Severity | Effort | Blocks                   |
| ---- | ------------------------------------------------------------------------ | -------- | ------ | ------------------------ |
| P0-1 | Journal double-post: no unique on `(source, sourceRefType, sourceRefId)` | P0       | S      | —                        |
| P0-2 | No payment idempotency key                                               | P0       | M      | —                        |
| P0-3 | Double disbursement: check-then-act without lock                         | P0       | S      | —                        |
| P1-4 | No row locking / conditional-update pattern anywhere                     | P1       | M      | P0-1..3                  |
| P1-5 | Scheduler has no distributed lock — blocks multi-process deploy          | P1       | S      | horizontal scaling       |
| P1-6 | No standing reconciliation invariant                                     | P1       | M      | —                        |
| P1-7 | No golden financial test corpus                                          | P1       | M      | **all calculation work** |

Order: P0-1 and P0-3 first (both small, both database-level, both eliminate a
class of error). P0-2 next. P1-7 before touching any arithmetic.
