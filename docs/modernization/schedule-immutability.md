# Schedule immutability — verifying the "Immutable schedule versions" row

**Status: verified. The audit's claim was wrong. No §12 violation. The row
closes without an implementation.**

The Phase 0 audit flagged `LoanSchedule` as **NEEDS VERIFICATION / P1** on the
claim that _"schedule rows mutate on restructure"_, and asked for the schedule
to be versioned per §25 if the mutation turned out to be in place. It is not.
The contractual terms of a `LoanSchedule` row are **write-once at disbursement
and never updated afterwards**, by any path, anywhere in the repository.

Characterisation tests pinning this are in
`libs/db/src/repositories/loan.repository.schedule-immutability.golden.test.ts`
(19 tests, committed passing against unmodified code, per §81).

---

## Where the line is drawn

The row's question only means something once you separate two kinds of column,
because a schedule row legitimately changes as a loan is serviced.

| Kind            | Columns                                                               | May it change?                                                                                                               |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Contractual** | `installmentNo`, `dueDate`, `principalDue`, `interestDue`, `totalDue` | **No.** This is the borrower's promise — what is owed and when. Editing it rewrites the contract, which is what §12 forbids. |
| **Servicing**   | `principalPaid`, `interestPaid`, `paidInFullAt`                       | **Yes.** This is how far through the promise the borrower has got. A rising `principalPaid` is the row doing its job.        |

§12 is about the first set. A payment moving the second set is not a history
rewrite, and treating it as one would make the model unimplementable.

---

## Evidence: every writer of `LoanSchedule`, whole repo

| Path                                                      | Op           | Columns written                                 | Contract touched? |
| --------------------------------------------------------- | ------------ | ----------------------------------------------- | ----------------- |
| `loan.repository.ts:1133` — `disburse`                    | `createMany` | `loanId` + all five contractual                 | **INSERT only**   |
| `loan.repository.ts:1264` — `disburse`, renewal settle    | `update`     | `paidInFullAt`, `principalPaid`, `interestPaid` | no                |
| `loan.repository.ts:1463` — `recordPayment`               | `update`     | `interestPaid`, `principalPaid`, `paidInFullAt` | no                |
| `loan.repository.ts:1667` — `closeEarly`                  | `update`     | `paidInFullAt`, `principalPaid`, `interestPaid` | no                |
| `loan.repository.ts:1790` — `restructure`                 | `update`     | `paidInFullAt`, `principalPaid`, `interestPaid` | no                |
| `loan.repository.ts:1933` — `writeOff`                    | `update`     | `paidInFullAt`, `principalPaid`, `interestPaid` | no                |
| `repossession.repository.ts:217` — `auction`              | `update`     | `paidInFullAt`, `principalPaid`, `interestPaid` | no                |
| `libs/db/scripts/repair-payments.mjs:259` — repair runner | `update`     | `principalPaid`, `interestPaid`, `paidInFullAt` | no                |
| `docs/smoke-tests/fixtures.ts:345/458/464` — dev fixtures | mixed        | insert + servicing                              | dev reseed only   |

Supporting facts, all verified:

- **No `UPDATE` anywhere passes a contractual column.** Zero occurrences across
  `libs/`, `apps/`, and `scripts/`.
- **No nested writes.** `schedule: { … }` appears 15 times and every one is a
  read filter. Neither `loanApplication.create` call writes a nested schedule.
- **No raw SQL writer.** There are no `.sql` files outside
  `libs/db/prisma/migrations/`, and the table is quoted PascalCase with no
  `@@map`, so no snake_case writer can hide. The only historical SQL update is
  the one-time `interestPaid` backfill in
  `20260523140000_schedule_payment_progress/migration.sql:40` — servicing only.
- **No deletes.** Nothing in production deletes a `LoanSchedule` or a
  `LoanApplication` row, so the `onDelete: Cascade` is never reached outside the
  `PICKER-*`-scoped dev fixture reseed.
- **`disburse` cannot run twice.** The atomic claim
  `updateMany({ where: { id, status: "APPROVED" } })` precedes the `createMany`,
  and `@@unique([loanId, installmentNo])` backs it up. Nothing rewinds a funded
  loan to `APPROVED`: `DECIDABLE_STATUSES` deliberately excludes
  `DISBURSED`/`ACTIVE`/`CLOSED`.

---

## Why `restructure` is already append-only

The audit read the `UPDATE` statements in `restructure` and inferred a rewrite.
What those statements do is _settle_ the original loan — mark its open
instalments closed — and the new terms then go somewhere else entirely:

```
restructure(original):
  claim original: ACTIVE|DISBURSED|DEFAULTED -> RESTRUCTURED   (atomic)
  settle original's open instalments          (servicing columns only)
  applyInTx(...) -> NEW LoanApplication, restructuredFromId = original.id
  post the settlement journal entry
```

The replacement is a **new row** that grows its **own** schedule at its own
disbursement. The original loan keeps its number, its status
(`RESTRUCTURED`), its `closedAt`, and every one of its original instalments
with their original due dates and amounts. `restructuredFromId` chains them,
and chaining off an already-restructured row is refused outright.

That is the versioned model the row asked for. It is implemented one level up —
at `LoanApplication` rather than at `LoanSchedule` — which is why a search of
the schedule table did not find it. A borrower's successive contracts are
separate loans, which is also how the ledger, the statements, and the loan
numbers already describe them.

---

## What a regulator can reconstruct today

- **The original contract, exactly**: every instalment of every restructured,
  closed, written-off, or repossessed loan survives with its `dueDate`,
  `principalDue`, `interestDue`, `totalDue`.
- **The chain of contracts**: `restructuredFromId` / `renewedFromId`, plus
  `RESTRUCTURED` + `closedAt` on each superseded loan.
- **Every payment ever made**: `LoanPayment` has **no** `update`, `delete`, or
  `upsert` call anywhere in the repository — it is append-only in practice.
- **Every financial movement**: journal entries are append-only and corrected
  by reversal; the restructure settlement entry names both loans and carries
  the remaining principal on its own line.

---

## The one residual gap (not §12, not P1)

The four force-settlement paths write `principalPaid := principalDue` and
`interestPaid := interestDue`. On a **part-paid** instalment this overwrites a
true figure with a fiction: a borrower who had paid 400 of 1,000 on instalment
1 shows 1,000 afterwards. Pinned by the last describe block in the golden test.

**Severity: P3.** It is a servicing column, not a contractual one, so it is not
a §12 violation, and the information is not destroyed system-wide — it is
recomputable by replaying the loan's append-only `LoanPayment` rows through
`allocatePayment`, which is exactly what `libs/db/src/lib/repair-payment-allocations.ts`
does. What is missing is that nothing performs that replay for these loans:
`auditLoan` deliberately **skips** force-settled loans ("a replay would invent a
payment history"), so the per-instalment truth is derivable but never derived.

The aggregate is fine — the settlement journal entry records the outstanding
that was settled. Only the **per-instalment split at the moment of settlement**
is unreadable without a replay.

### If it is ever scheduled, the fix is small

Not schedule versioning — versioning a table whose contractual columns never
change would add a join to every read to protect data that is already safe. The
proportionate fix is one append-only row per settled instalment:

```prisma
model ScheduleSettlement {
  id         String   @id @default(uuid())
  scheduleId String
  /// LoanRestructure | LoanCloseEarly | LoanWriteOff | RepossessionAuction |
  /// RenewalSettlement — matches the journal entry's sourceRefType.
  reason     String
  /// The journal entry that booked this settlement, so the row joins to money.
  sourceRefId String
  /// What the borrower had actually paid, immediately before the overwrite.
  principalPaidBefore Decimal @db.Decimal(14, 2)
  interestPaidBefore  Decimal @db.Decimal(14, 2)
  settledAt  DateTime @default(now())
  settledById String?

  schedule LoanSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)

  /// One settlement per instalment: an instalment is settled once, and this
  /// serialises the write the same way DecisionRuleVersion's unique index
  /// serialises version minting.
  @@unique([scheduleId])
  @@index([sourceRefId])
}
```

Then the five settlement loops write this row before their `update`. Scope:

- **Migration backfill**: for existing rows, `principalPaidBefore` is not
  recoverable from the schedule (it was overwritten). Backfill it by replaying
  `LoanPayment` through `allocatePayment` per loan — the `auditLoan` machinery
  already exists and would need its force-settled skip lifted for backfill mode
  only. Where a loan has no payments, backfill zeroes. Mark backfilled rows
  with `reason` suffixed `_BACKFILL` so a reader can tell derived from observed.
- **API/UI breakage**: none. Nothing reads these columns expecting the old
  shape; this is additive. A statement view could optionally surface
  "settled early — X of Y actually paid".
- **Golden tests**: the existing 19 stay valid. Add assertions that each
  settlement path writes exactly one `ScheduleSettlement` per instalment it
  closes, that `principalPaidBefore` equals the row's pre-update value, and
  that a re-run (idempotent replay) does not write a second row.
