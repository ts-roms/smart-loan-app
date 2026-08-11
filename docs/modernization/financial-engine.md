# Financial Engine

Living reference for how money is represented, computed and guaranteed.
Point-in-time findings live in `financial-engine-audit.md`; this describes the
system as it now stands.

---

## Money representation — §11

| Rule               | Implementation                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| No float for money | **79** `Decimal` columns; **5** `Float`, none monetary (`SurveyFactor.weight`, two biometric scores, two DORSI percentages) |
| Explicit precision | **0** Decimal columns without `@db.Decimal(p,s)`                                                                            |
| Currency precision | `Decimal(14,2)` ×45 — the standard money column                                                                             |
| Large aggregates   | `Decimal(18,2)` ×11, `Decimal(20,2)` ×1                                                                                     |
| Interest rates     | `Decimal(5,4)` ×11, `Decimal(6,4)` ×8 — four decimal places, i.e. 0.0001 = 1 basis point                                    |
| Other              | `Decimal(10,2)`, `Decimal(5,2)` ×1 each                                                                                     |

### Rounding mode — the part §11 asks to be documented

**Half-up at two decimals, applied at the boundary of every computation**, via a
single helper repeated per module:

```ts
const round2 = (n: number) => Math.round(n * 100) / 100;
```

`Math.round` in JavaScript is half-up **for positive numbers** (`Math.round(2.5) === 3`)
and half-up-toward-positive-infinity for negatives (`Math.round(-2.5) === -2`).
Every monetary quantity in this system is non-negative by construction —
`buildEntry` rejects a negative line outright — so the negative case does not
arise in the ledger. It _can_ arise in an ECL provision delta, which is
deliberately allowed to swing both ways; that value is a movement, not a
balance, and is rounded once at the point of posting.

| Stage                       | Precision                                                                            | Where                               |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| Interest accrual per period | computed on the **unrounded** balance, rounded once for the row                      | `decliningSchedule`                 |
| Schedule principal          | rounded per row; **final row trues up** so rounded rows sum to exactly the principal | `decliningSchedule`, `flatSchedule` |
| Payment allocation          | rounded per installment slice, and per bucket total                                  | `allocatePayment`                   |
| Journal line                | rounded before the balance check                                                     | `buildEntry`                        |
| Balance tolerance           | one centavo (`PENNY`)                                                                | `buildEntry`                        |

**Why the true-up exists.** A loan is booked to Loans Receivable at full
principal on disbursement. If the rounded schedule rows do not sum to exactly
that principal, a borrower who pays every instalment in full still leaves a
residual on the receivable — a debt that can never be settled. The last row
absorbs the accumulated drift. This is asserted in `golden-corpus.test.ts` for
all eight scenarios.

---

## Guarantees

The architectural rule (see `recommended-architecture.md` §3): **a check
followed by an action is something a second request can walk between; a unique
index or a conditional `UPDATE … WHERE` is not.**

| Operation                 | Guarantee                                                   | Behaviour on conflict                        |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Auto-posted journal entry | `UNIQUE(source, sourceRefType, sourceRefId)`                | returns the existing entry, `created: false` |
| Payment                   | `UNIQUE(LoanPayment.idempotencyKey)`                        | replays the original payment, 201            |
| Disburse                  | `UPDATE … WHERE status = 'APPROVED'`                        | 0 rows → refuse, naming current status       |
| Decide                    | `UPDATE … WHERE status IN (decidable) AND status <> target` | 0 rows → 409 `LoanNotDecidable`              |
| Close early               | `UPDATE … WHERE status IN ('ACTIVE','DISBURSED')`           | 0 rows → refuse                              |
| Write off                 | `UPDATE … WHERE status NOT IN ('WRITTEN_OFF','CLOSED')`     | 0 rows → refuse                              |
| Scheduled job slot        | compare-and-swap on `nextRunAt`                             | 0 rows → skip this tick                      |

Manual journal entries have `sourceRefId = NULL` and are exempt: Postgres treats
NULLs as distinct in a unique index, so repeated manual entries are permitted,
which is correct.

### Idempotency contract

`POST /loans/:id/payments` accepts an `Idempotency-Key` header (body field
`idempotencyKey` as fallback, min 8 chars). A repeat returns the **original**
payment with 201 — a retry after a timeout is a question to be answered the same
way, not an error to report.

**Not yet covered:** provider callbacks (`POST /payments/providers/:provider`).
Providers deliver at-least-once. This is the one remaining P0 in the gap matrix.

---

## Immutable history — §12

Posted journal entries are never edited or deleted. Correction is by reversal:
`reverseEntry` creates a new entry with debit and credit swapped per line, and
links the pair via `reversedById`. `invariants.test.ts` asserts every account
nets to zero across an original/reversal pair.

Orphan cleanup exists (`sweep-orphaned-entries.mjs`) but refuses any entry type
it does not have an explicit owner mapping for, and checks the trial balance
after.

---

## Reconciliation status

The identity the brief (§10) requires:

```
Loan Balance = Loan Transactions = Payment Allocations = Accounting Entries
```

Enforced today by construction (allocation conservation, entry balance) and
asserted in `invariants.test.ts`. **Not yet asserted continuously against live
data** — that is roadmap 2.3, a standing job comparing subledger to GL per
period. Today the only standing proof is a manual trial balance.

---

## Testing

| Suite                                               | Count | Guards                                                                                               |
| --------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `libs/accounting/src/invariants.test.ts`            | 18    | entry balance across all 20 builders, reversal netting, allocation conservation, zero-amount refusal |
| `libs/loans/src/ledger-position.invariants.test.ts` | 8     | non-negative positions, interest never counted as held, per-loan flooring                            |
| `libs/loans/src/golden-corpus.test.ts`              | 49    | 8 scenarios; half closed-form verified, half characterization                                        |
| `libs/db/src/repositories/*.idempotency.test.ts`    | 12    | replay, race, wrong-constraint rethrow                                                               |
| `loan.repository.decide.test.ts`                    | 15    | decidable transitions, race, funded statuses                                                         |

**Before changing any calculation:** the golden corpus must pass unchanged, and
its VERIFIED half must pass without amendment. See `testing.md`.
