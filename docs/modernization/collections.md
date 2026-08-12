# Collections

Delinquency, follow-up and recovery. Read from the code on 11 Aug 2026.

---

## What exists

| Capability           | Implementation                                                                           | Tables                            |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| Overdue queue        | `CollectionsRepository.overdueQueue` — loans with any schedule row past due as of a date | `LoanApplication`, `LoanSchedule` |
| Days overdue         | computed from the **earliest** unpaid due date                                           | derived                           |
| Collector assignment | per loan, with batch hand-out                                                            | `CollectionAssignment`            |
| Contact history      | free-text notes with author and timestamp                                                | `CollectionNote`                  |
| Promise to pay       | amount, promised date, status, resolution                                                | `PromiseToPay`                    |
| Demand letters       | draft → approve → dispatch, with escalation levels                                       | `DemandLetter`                    |
| Repossession         | case workflow through to auction and deficiency posting                                  | `RepossessionCase`                |
| Write-off            | terminal, posts principal to Bad Debt                                                    | `LoanApplication`                 |
| Penalty waiver       | partial or full reversal of accrued late fees                                            | `PenaltyWaiver`                   |
| Late-fee accrual     | daily, per overdue installment                                                           | `libs/loans/src/late-fees.ts`     |

12 endpoints under `/collections`, plus 7 for demand letters and 11 for
repossession. Frontend: `/collections`, `/collections/my-accounts`,
`/collections/demand-letters`, `/repossession`.

## Aging buckets

`buildAgingReport` (`libs/accounting/src/reports.ts`) classifies into the
**seven** §28 bands, as of 12 Aug 2026:

```
CURRENT      daysOverdue <= 0
D_1_30       <= 30
D_31_60      <= 60
D_61_90      <= 90
D_91_120     <= 120
D_121_180    <= 180
D_180_PLUS   everything beyond
```

Upper bounds are inclusive, so a loan exactly 90 days overdue is still
`D_61_90` and 91 is the first non-performing day — the direction that does
_not_ flatter the book.

It used to stop at `D_90_PLUS`, which collapsed a 91-day account and a
three-year account into one number. Those are entirely different recovery
propositions: one is still being worked, the other is a write-off candidate.
The split also unlocks roll-rate analysis (§30), which needs the finer grain to
mean anything.

**Report-only, and that is why it was cheap.** Nothing persists a bucket and
nothing computes money from one — ECL stages independently on days-past-due
(`ecl.repository.ts`) — so this moved no provision, restated no ledger, and
needed no migration.

Two lists that used to be maintained by hand are now derived: the report order
comes from the label `Record`, which the type makes exhaustive, and
portfolio-at-risk sums by excluding `CURRENT` rather than by naming the overdue
bands. Both were guarding the same failure — a band added later that renders in
the table while quietly dropping out of the total above it.

## Gaps against §28–§30

| Requirement                     | Status                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Collection queue                | **EXISTS — GOOD**                                                                                                |
| Collector assignment + workload | **EXISTS** (assignment yes; workload view not confirmed)                                                         |
| Contact history                 | **EXISTS**                                                                                                       |
| Promise to pay                  | **EXISTS — GOOD**                                                                                                |
| Follow-up scheduling            | **PARTIAL** — PTP carries a promised date; no general follow-up queue                                            |
| SMS / Email                     | **EXISTS** via `libs/notifications`                                                                              |
| Field visit                     | **MISSING** as a distinct activity type                                                                          |
| Demand letter                   | **EXISTS — GOOD**                                                                                                |
| Legal escalation                | **PARTIAL** — demand-letter levels exist; no separate legal case model                                           |
| Repossession                    | **EXISTS — GOOD**                                                                                                |
| Recovery / write-off            | **EXISTS**                                                                                                       |
| Recovery _after_ write-off      | **NEEDS VERIFICATION** — write-off is terminal; whether a later recovery can be posted against it was not traced |
| Seven aging buckets             | **EXISTS** — §28's bands, 11 tests on the boundaries                                                             |
| Collection priority score (§29) | **MISSING**                                                                                                      |
| Roll-rate analysis (§30)        | **MISSING**                                                                                                      |

## Collection priority score — §29, not built

§29 asks for a score over DPD, outstanding balance, risk grade, probability of
payment, contactability, customer history, collateral and recovery probability,
producing a priority, a recommended action, a next follow-up date and a channel.

Every **input** for a first version already exists: DPD and outstanding from the
queue, risk grade from `CreditScore.tier`, collateral from `Vehicle`/`Property`,
history from `LoanPayment` and prior `PromiseToPay` outcomes. What is missing is
the scoring function and somewhere to put the output.

This is P3 in the roadmap — genuinely valuable, not urgent, and the sort of
thing that should be built once the seven buckets exist so that "recommended
action" can key off a meaningful band.

## Recovery-after-write-off — resolved

`PAYABLE_STATUSES` includes `WRITTEN_OFF`, so a recovery payment is accepted.
Tracing what it _posted_ turned up a real defect — the whole amount was booked
to Customer Advances, recording the defaulter as a creditor — fixed on 11 Aug
with a dedicated Bad Debt Recovery account. Full account in `accounting.md`.
