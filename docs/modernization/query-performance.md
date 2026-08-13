# Query performance — plans, indexes, and rejections

Roadmap 4.2. The rule for this batch was **evidence before indexes**: an index
added on a hunch costs write throughput and storage forever and is nearly
impossible to retire later, because nobody can prove it is unused. So every
index below is backed by a captured `EXPLAIN ANALYZE` from before and after,
and the indexes that were **measured and rejected** are recorded here too. The
rejections are the more useful half of this document.

**Result: 21 query shapes examined, 6 indexes added, 5 candidates rejected,
4 slow queries reported that no index can fix.**

---

## 1. Where the measurements came from

### The dev database could not be measured

`smart_loan` on `127.0.0.1:5433` is the shared dev database. Its business
tables are effectively empty:

| Table                                                                | Rows |
| -------------------------------------------------------------------- | ---- |
| `RolePermission`                                                     | 165  |
| `RefreshToken`                                                       | 352  |
| `JobRun`                                                             | 205  |
| `AuditEvent`                                                         | 44   |
| `JournalEntry`                                                       | 27   |
| `Customer`                                                           | 13   |
| `LoanApplication`                                                    | 10   |
| `LoanSchedule` / `LoanPayment` / `JournalLine` / `BankStatementLine` | 0    |

At that size Postgres correctly sequential-scans everything, and every plan is
a flat 0.0-something milliseconds. Nothing can be concluded from it. (The 27
journal entries corroborate `MIGRATIONS.md`, which records the same count when
`journal_source_ref_unique` was added.)

The dev database was therefore used **read-only** for the whole investigation.

### A separate scratch database was seeded

Per the brief's allowance, volume was created in a **separate scratch
database**, `smart_loan_perf`, on the same server — never in `smart_loan`.
Schema applied with `prisma migrate deploy`, then loaded with synthetic rows
shaped like a mature mid-size lender's book:

| Table               | Rows      | Heap size |
| ------------------- | --------- | --------- |
| `LoanSchedule`      | 1,296,000 | 184 MB    |
| `JournalLine`       | 800,000   | 55 MB     |
| `LoanPayment`       | 480,000   | 147 MB    |
| `JournalEntry`      | 400,000   | 84 MB     |
| `LoanApplication`   | 120,000   | 26 MB     |
| `BankStatementLine` | 60,000    | 10 MB     |
| `Customer`          | 50,000    | 10 MB     |

Two seeding mistakes were found and corrected before any conclusion was drawn,
because each would have manufactured a false result:

- **Every `ACTIVE` loan was perfectly current**, so `paidInFullAt IS NULL AND
dueDate < now()` matched almost nothing and any index measured against it
  would have looked spectacular for a fictional reason. ~20% of live loans were
  put into genuine arrears, giving 8,472 overdue instalments on live loans out
  of 196,152 open ones.
- **Every `LoanPayment.amount` was the same value**, so the bank-reconciliation
  amount lookup matched on the first row it touched and hid its own cost.
  Amounts were spread over 25,000 distinct values.

Final predicate selectivity, which is what the index decisions actually rest on:

| Predicate                                  | Matches | of        | Share |
| ------------------------------------------ | ------- | --------- | ----- |
| `LoanSchedule.paidInFullAt IS NULL`        | 196,152 | 1,296,000 | 15.1% |
| `… AND dueDate < now()`                    | 110,072 | 1,296,000 | 8.5%  |
| `… AND loan.status IN (ACTIVE, DISBURSED)` | 8,472   | 1,296,000 | 0.7%  |
| `LoanApplication.disbursedAt IS NOT NULL`  | 108,000 | 120,000   | 90.0% |
| `Customer.archivedAt IS NULL`              | 49,000  | 50,000    | 98.0% |

### Reading the numbers below

Wall-clock time on this host is noisy — the first run of any query pays cold
I/O, and two runs of an identical plan varied by more than 2×. **Buffer counts
are the stable metric** and are quoted alongside every timing. Both columns
come from a warm-cache A/B: candidate indexes created, two full passes, second
kept; then indexes dropped, two full passes, second kept.

---

## 2. Indexes added — six

| #   | Index                                                               | Query                         | Time                      | Buffers          |
| --- | ------------------------------------------------------------------- | ----------------------------- | ------------------------- | ---------------- |
| 1   | `Customer(createdAt DESC)`                                          | Q6 customer list              | 39.1 → 0.46 ms (**84×**)  | 5,479 → 586      |
| 2   | `LoanApplication(submittedAt DESC)`                                 | Q7 loans list                 | 27.8 → 0.49 ms (**57×**)  | 13,558 → 404     |
| 3   | `LoanApplication(disbursedAt)`                                      | Q4 YTD originations           | 61.1 → 7.2 ms (**8.5×**)  | 3,340 → 634      |
|     |                                                                     | Q10c recon disbursement match | 50.7 → 0.99 ms (**51×**)  | 10,002 → 172     |
| 4   | `LoanSchedule(paidInFullAt, dueDate)`                               | Q1 aging report               | 406 → 311 ms              | 57,894 → 32,589  |
|     |                                                                     | Q2 nightly accrual driver     | 184 → 139 ms              | 84,412 → 26,640  |
|     |                                                                     | Q11 collections queue         | 360 → 137 ms (**2.6×**)   | 104,628 → 42,895 |
| 5   | `LoanPayment(amount, paidOn)`                                       | Q10b recon payment match      | 231 → 0.12 ms (**1861×**) | 56,524 → 101     |
| 6   | `JournalEntry(source, sourceRefType, sourceRefId text_pattern_ops)` | Q9 late-fee prefix            | 109 → 0.32 ms (**342×**)  | 13,531 → 54      |

Cost of carrying them, measured at the volume above:

| Index                                          | Size   | vs table | Build time |
| ---------------------------------------------- | ------ | -------- | ---------- |
| `Customer_createdAt_idx`                       | 392 kB | 10 MB    | 116 ms     |
| `LoanApplication_submittedAt_idx`              | 816 kB | 26 MB    | 196 ms     |
| `LoanApplication_disbursedAt_idx`              | 824 kB | 26 MB    | 80 ms      |
| `LoanSchedule_paidInFullAt_dueDate_idx`        | 9.3 MB | 184 MB   | 1,869 ms   |
| `LoanPayment_amount_paidOn_idx`                | 14 MB  | 147 MB   | 1,173 ms   |
| `JournalEntry_source_refType_refId_prefix_idx` | 30 MB  | 84 MB    | 1,938 ms   |

### Q6 — customer list (`customer.repository.ts:181`)

`orderBy: { createdAt: "desc" }`, page size 200 by default, 500 max. There was
no index on `Customer.createdAt` at all.

Before — read the whole table to return 200 rows:

```
Limit (actual rows=200)
  ->  Gather Merge
        ->  Sort  Sort Key: "createdAt" DESC
              Sort Method: top-N heapsort  Memory: 51kB
              ->  Parallel Seq Scan on "Customer"  (actual rows=24500 loops=2)
                    Filter: ("archivedAt" IS NULL)
 Execution Time: 39.098 ms
```

After:

```
Limit (actual rows=200)
  ->  Index Scan using "Customer_createdAt_idx" on "Customer"
        Filter: ("archivedAt" IS NULL)
 Execution Time: 0.464 ms
```

`archivedAt IS NULL` stays a filter rather than an index condition, which is
correct — it matches 98% of rows and is not worth indexing on. The existing
`@@index([archivedAt])` is untouched.

**Caveat, recorded honestly:** at `OFFSET 20000` (Q6b) the index wins on time
(51 → 19 ms) but _loses_ on I/O — 4,732 → 41,279 buffers — because the index
scan walks 20,200 entries and fetches each from the heap, where the seq scan
read each page once. Deep offsets are a pagination problem, not an index
problem; page 1 is the overwhelmingly common access and this index is chosen
for that.

### Q7 — loans list (`loan.repository.ts:471`)

`orderBy: { submittedAt: "desc" }` with no status filter is the default view.
The existing `@@index([status, submittedAt])` **cannot** serve it, because
`status` leads — a composite on `(a, b)` serves `a` alone, never `b` alone.
Before: parallel seq scan + top-N heapsort, 13,558 buffers. After: index scan,
404 buffers, 57×.

Q7b confirms the existing composite is doing its job when a status _is_
supplied: 0.28 ms, 404 buffers, `Index Scan Backward using
"LoanApplication_status_submittedAt_idx"`. **No change needed there.**

This index also improved Q15 (`balancesFor`, the schedule fold behind a loans
page) from 78.9 → 29.7 ms, 30,590 → 3,562 buffers, by serving the subquery that
picks the page's loan ids.

### Q4 / Q10c — `LoanApplication(disbursedAt)`

Two unrelated callers, one index. YTD originations on the dashboard
(`accounting.repository.ts:464`) went 61.1 → 7.2 ms. The bank-reconciliation
disbursement candidate search (`bank-reconciliation.repository.ts:208`,
`principal = X AND disbursedAt BETWEEN …`) went 50.7 → 0.99 ms, 10,002 → 172
buffers.

**This index does _not_ help the roll-rate report** — see rejection R1.

### Q1 / Q2 / Q11 — `LoanSchedule(paidInFullAt, dueDate)`

The single most reused shape in the app: "open instalments", optionally "and
already due". It backs the aging report (`accounting.repository.ts:743`),
`portfolioSummary` (`:421`), the collections queue (`collections.repository.ts:164`)
and the nightly late-fee accrual driver (`:477`).

`paidInFullAt` leads deliberately. It is the selective half (15%), and btree
**does** index NULLs, so `IS NULL` becomes part of the index condition rather
than a filter — this is why a partial index (`WHERE paidInFullAt IS NULL`) was
not needed, which matters because **Prisma 6 cannot express partial indexes in
`schema.prisma`** and a raw-SQL-only index would show up forever as schema
drift.

Q2 before — filter discards 1.19M rows:

```
Parallel Seq Scan on "LoanSchedule" s  (actual rows=33973 loops=3)
  Filter: (("paidInFullAt" IS NULL) AND ("dueDate" < now()))
  Rows Removed by Filter: 398027
 Buffers: shared hit=3632 read=23297
```

Q2 after — both predicates are index conditions:

```
Bitmap Heap Scan on "LoanSchedule" s  (actual rows=110072)
  Recheck Cond: (("paidInFullAt" IS NULL) AND ("dueDate" < now()))
  ->  Bitmap Index Scan on "LoanSchedule_paidInFullAt_dueDate_idx"
        Index Cond: (("paidInFullAt" IS NULL) AND ("dueDate" < now()))
 Buffers: shared hit=8138
```

The time gain here is modest (1.3×) but the I/O gain is 3.2× on Q2 and 2.4× on
Q11, and these run on the whole book nightly. The existing `@@index([dueDate])`
is kept: it still serves date-range queries that do not constrain
`paidInFullAt`, which the new composite cannot lead with.

### Q9 — the late-fee prefix lookup, and why it is not a duplicate index

`collections.repository.ts:511` looks up late-fee entries by
`sourceRefId: { startsWith: "<scheduleId>:" }`. There is already a unique index
on exactly `(source, sourceRefType, sourceRefId)`. A reviewer will reasonably
ask why a second index on the same three columns is not redundant.

Because this database collates `en_US.utf8`, and **under a non-C collation a
default-opclass btree cannot answer a LIKE prefix range at all.** The plan
proves it — the unique index narrowed to `(source, sourceRefType)`, then threw
away 99,996 of 100,000 rows _after_ fetching them from the heap:

```
Bitmap Heap Scan on "JournalEntry" e  (actual rows=4)
  Recheck Cond: ((source = 'LATE_FEE_ACCRUAL') AND ("sourceRefType" = 'LoanScheduleLateFee'))
  Filter: ("sourceRefId" ~~ '318f9fd9...:%')
  Rows Removed by Filter: 99996
  Heap Blocks: exact=10804
 Execution Time: 109.24 ms
```

With `text_pattern_ops` on the third column the prefix becomes an index
condition:

```
Index Scan using "JournalEntry_source_refType_refId_prefix_idx"  (actual rows=4)
  Index Cond: (... AND "sourceRefId" ~>=~ '318f9fd9...:' AND "sourceRefId" ~<~ '318f9fd9...;')
  Filter: ("sourceRefId" ~~ '318f9fd9...:%')
 Buffers: shared hit=54
 Execution Time: 0.32 ms
```

The unique index keeps its collation semantics because it enforces posting
idempotency; the opclass is not changed on it.

**This is the highest-value index in the batch**, because the query sits inside
an N+1 loop — see finding F1.

### Q10b — `LoanPayment(amount, paidOn)`

`bank-reconciliation.repository.ts:172` matches a statement line to a payment
by exact amount inside a date window. The existing `@@index([loanId, paidOn])`
is useless here: there is no loan id at that point, which is the entire reason
the match is being guessed. 231 → 0.12 ms, 56,524 → 101 buffers.

---

## 3. Indexes considered and REJECTED — five

### R1. `LoanApplication(disbursedAt)` _as a fix for the roll-rate report_ — rejected

The roll-rate report (`accounting.repository.ts:785`) reads
`disbursedAt IS NOT NULL AND disbursedAt <= to AND status IN (6 of 12 values)`.
That is **90% of the table** (107,440 of 120,000 rows). With the index present
the planner ignored it and kept the sequential scan, and buffers were
unchanged — 3,352 before, 3,355 after:

```
Seq Scan on "LoanApplication" l  (actual rows=107440)
  Filter: (("disbursedAt" IS NOT NULL) AND ("disbursedAt" <= now()) AND (status = ANY (...)))
  Rows Removed by Filter: 12560
 Buffers: shared hit=3334
```

A sequential scan is the _correct_ plan for reading 90% of a table. The index
is still added — but justified by Q4 and Q10c only. Had those two not existed,
the finding here would have been "no index needed".

### R2. `BankStatementLine(matchedType, matchedRefId)` — rejected

This one genuinely works, which is why it is worth explaining. It becomes a
covering index-only scan with zero heap fetches, 33.5 → 14.7 ms, 1,398 → 413
buffers.

Rejected anyway, for three reasons:

1. The query returns **40,000 of 60,000 rows** (67%). An index whose only
   benefit is avoiding the heap on two-thirds of a table is a weak index.
2. The real cost is not the query, it is that `claimedRefIds` is called **once
   per statement line inside the matching loop** (`:170`, `:206`) with no
   per-line argument — the result is identical every time. Halving a query that
   should be executed once instead of N times is not a fix; it makes the
   pathology survive longer without being noticed.
3. The write cost lands exactly where it hurts. `matchedType` / `matchedRefId`
   are `UPDATE`d by every match (`:186`, `:217`), so this index would have to
   be maintained on the write path of the very loop that is already slow.

The correct fix is to hoist the call out of the loop — a code change, reported
as finding F2, not indexed around.

### R3. Partial indexes (`WHERE paidInFullAt IS NULL`) — rejected

Measured as a plain composite instead. A partial index would be smaller, but
**Prisma 6.19 cannot express a `WHERE` clause on `@@index`**, so it would exist
only in raw SQL and would be reported as drift by `prisma migrate diff` on
every future migration — and the standing remedy for drift is a reset. Since
btree indexes NULLs, `(paidInFullAt, dueDate)` gets the same index condition
with no drift risk. The size penalty is 9.3 MB against a 184 MB table.

### R4. An index for `ledgerLines` / trial balance / balance sheet — rejected

`accounting.repository.ts:833`, called by `trialBalance` and `balanceSheet`
with only `{ to: asOf }`, so `entryDate <= asOf` is unbounded — it selects
**every journal line ever written**. Q8: 1.72 s, 73,343 buffers, and buffers
were **identical** with every candidate index present. There is nothing to
index; the query asks for the whole ledger. See finding F3.

By contrast Q8b, the bounded `incomeStatement` variant, already uses
`JournalEntry_entryDate_idx` correctly. **No index needed.**

### R5. An index for the reconciliation checks — rejected

`reconciliation.ts` is whole-book by design and correctly so. Buffers were
unchanged with all candidates present:

| Check                 | Line   | Time   | Buffers before → after |
| --------------------- | ------ | ------ | ---------------------- |
| Unbalanced entries    | `:99`  | 6.76 s | 150,828 → 150,828      |
| Duplicate source refs | `:133` | 486 ms | 10,006 → 10,009        |
| Schedule sanity       | `:169` | 1.01 s | 47,148 → 47,148        |

The duplicate-ref check (`:133`) already resolves through
`journal_source_ref_unique` for its grouping — the existing index is doing its
job. The schedule sanity check compares **column against column**
(`principalPaid > principalDue + 0.01`), which no btree index can serve. The
unbalanced-entry check joins and groups the entire ledger. All three are
correct as written for a nightly job. **No index needed.**

### Also checked and left alone

`Customer(phone)`, `Customer(governmentIdType, governmentIdNumber)`,
`Customer(archivedAt)`, `LoanApplication(customerId, status)`,
`LoanApplication(status, submittedAt)`, `LoanApplication(agentId, submittedAt)`,
`LoanSchedule(loanId, installmentNo)`, `LoanPayment(loanId, paidOn)`,
`JournalEntry(entryDate)`, `JournalLine(entryId)`, `JournalLine(accountId)`,
`CollectionNote(loanId, createdAt)`, `CreditScore(customerId, computedAt)` —
all already present and all confirmed to be the index the planner picks for
their query. **Six of the eight hottest paths were already correctly indexed.**

No redundant prefix was added: each new composite leads with a column no
existing index leads with.

---

## 4. Slow queries no index can fix — reported, not changed

Per the brief these are **reported only**. Each is a behaviour change to
financial reporting or posting code and needs its own review.

### F1. The nightly late-fee accrual is O(overdue instalments) round trips

`collections.repository.ts:490` opens `for (const inst of installments)` over
every open overdue instalment in the book, and inside it runs a
`JournalEntry.findMany` (`:511`) **plus** a `postIfAbsent`. At the measured
volume that loop body executes **8,472 times per night**, each iteration
costing 109 ms before this batch — roughly **15 minutes of database time**,
serially, at 02:00.

Index 6 cuts each iteration to 0.32 ms (~3 seconds total), which is why it was
worth adding. But the N+1 remains: the fix is one batched query keyed on the
instalment ids, not 8,472 queries. Same pattern on the read path at
`loan.repository.ts:2011` as an `OR` of N `startsWith` clauses.

### F2. `autoMatch` re-runs an invariant query once per statement line

`bank-reconciliation.repository.ts:170` and `:206` call `claimedRefIds()` inside
the per-line loop with no per-line argument — the result is identical for every
iteration. Hoisting it out of the loop is a one-line change that removes N-1
full scans. See rejection R2.

### F3. `trialBalance` and `balanceSheet` materialize the entire ledger in JS

`accounting.repository.ts:833` selects every journal line ever written, hydrates
it into Node with the `Account` row duplicated per line, and sums in JavaScript.
1.72 s and 73,343 buffers at 800k lines, growing linearly and unboundedly.
`accountBalance` (`:565`) does the same for a single account and is called twice
per dashboard load — Q16, 1.40 s, 52,075 buffers. Both should be a SQL
`aggregate`/`groupBy`; neither is an indexing problem.

### F4. Unpaginated whole-book reads

`rollRate` (`:785`) returns the entire historical book **including every
schedule row of every loan** and is exposed as an on-demand HTTP endpoint.
`loanPortfolioAging` (`:743`) and `overdueQueue`
(`collections.repository.ts:164`) have no `take`/`skip` at all — `overdueQueue`
cannot paginate because it sorts by a score computed in JS after the fetch.
These need incremental or paginated designs, not indexes.

---

## 5. Multi-tenancy

This is a **schema-per-tenant** deployment, so an index that lands only in
`public` would silently miss every real tenant, and the plan measured would not
be the plan production runs.

The mechanism is already in place and this migration uses it unchanged:
`prisma migrate deploy` is run once per schema with `DATABASE_URL` carrying
`?schema=tenant_<slug>` (`libs/db/src/lib/multi-tenant-migrate.ts`), driven by
`libs/db/scripts/migrate-tenants.mjs`. What that requires of the migration is
simply that **table names are not schema-qualified**, so they resolve to
whichever schema is being migrated. Every statement in
`20260813090000_query_plan_indexes` follows the existing convention and is
unqualified. There is nothing tenant-specific to add.

Verified against all three targets `MIGRATIONS.md` requires:

| Target                                                                      | Result                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| `public` on the dev database                                                | applied; all 6 indexes present                    |
| A freshly provisioned tenant (`tenant_perftest`, every migration from zero) | applied; all 6 indexes present, 255 indexes total |
| An existing schema with rows (`smart_loan_perf`, ~2.6M rows)                | applied; row counts unchanged                     |

### Large tenants: concurrent build runbook

`CREATE INDEX` takes a `SHARE` lock: it blocks **writes** to the table while it
builds (reads are unaffected). At the volume measured the worst case was 1.9 s
(`LoanSchedule`, 1.3M rows). The tables where this could matter on a large
tenant, in order: `LoanSchedule`, `LoanPayment`, `JournalEntry`.

`CREATE INDEX CONCURRENTLY` is **deliberately not used in the migration**.
Prisma wraps each migration file in a transaction and `CONCURRENTLY` cannot run
inside one — shipping it would fail the migration outright rather than degrade
gracefully. There is no precedent for it anywhere in this repository.

For a tenant large enough that a multi-second write stall is unacceptable,
build the indexes by hand **before** running the migration, outside any
transaction, then run the migration normally — `CREATE INDEX` is a no-op once
the index exists, so the migration will simply record itself:

```sql
-- Run against tenant_<slug>, one at a time, outside a transaction.
SET search_path TO "tenant_<slug>";
CREATE INDEX CONCURRENTLY "Customer_createdAt_idx" ON "Customer"("createdAt" DESC);
CREATE INDEX CONCURRENTLY "LoanApplication_submittedAt_idx" ON "LoanApplication"("submittedAt" DESC);
CREATE INDEX CONCURRENTLY "LoanApplication_disbursedAt_idx" ON "LoanApplication"("disbursedAt");
CREATE INDEX CONCURRENTLY "LoanSchedule_paidInFullAt_dueDate_idx" ON "LoanSchedule"("paidInFullAt", "dueDate");
CREATE INDEX CONCURRENTLY "LoanPayment_amount_paidOn_idx" ON "LoanPayment"("amount", "paidOn");
CREATE INDEX CONCURRENTLY "JournalEntry_source_refType_refId_prefix_idx"
  ON "JournalEntry"("source", "sourceRefType", "sourceRefId" text_pattern_ops);
```

`CONCURRENTLY` can leave an `INVALID` index behind if it is interrupted. Check
before running the migration, and drop/rebuild any that are invalid:

```sql
SELECT c.relname FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid;
```

---

## 6. Pre-existing migration drift — found, not fixed

`prisma migrate diff` reports drift between `prisma/migrations` and
`schema.prisma` that **pre-dates this batch**. Confirmed by running the same
diff against the pristine schema at `HEAD`:

```
-- DropIndex / CreateIndex   Lead_status_createdAt_idx      (identical, no-op churn)
-- CreateIndex               AuditEvent_impersonatedById_idx
-- CreateIndex               Customer_erasedAt_idx
-- RenameIndex               journal_source_ref_unique -> JournalEntry_source_sourceRefType_sourceRefId_key
```

Three indexes are declared in `schema.prisma` but were never written into a
migration, and the unique constraint's database name does not match what Prisma
derives (`@@unique(..., name:)` sets the _client-facing_ name; `map:` sets the
database one).

**Consequence, and why `migrate deploy` was used here:** because of this drift,
`npx prisma migrate dev` does not run clean on the dev database — it detects
drift and offers to **reset**, which would destroy the dev data. This migration
was therefore applied with `prisma migrate deploy`, which never resets, and
`migrate dev` was exercised on a throwaway database instead. After
`migrate deploy`, `prisma migrate status` reports _"Database schema is up to
date!"_.

Not fixed in this batch: resolving it means renaming the index that enforces
**journal posting idempotency**, which is financial-integrity machinery and
deserves its own migration and review. Filed here so it is not rediscovered.

---

## 7. Reproducing this

```bash
# scratch database — never the dev one
createdb -h 127.0.0.1 -p 5433 -U loan smart_loan_perf
cd libs/db && DATABASE_URL="postgres://loan:loan@127.0.0.1:5433/smart_loan_perf" \
  npx prisma migrate deploy --schema prisma/schema.prisma
# then seed volume, and run each query under
#   EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
# twice, keeping the second run.
```

Use `127.0.0.1`, **not** `localhost` — with `localhost` Prisma reports `P1000
authentication failed`, which is a red herring and will send you debugging
credentials that are fine.

Index usage in a live database, to decide later whether any of these earned
their keep:

```sql
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE schemaname = current_schema()
ORDER BY idx_scan;
```
