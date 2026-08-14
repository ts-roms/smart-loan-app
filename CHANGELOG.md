# Changelog

Notable changes to Smart Loan. Format follows [Keep a Changelog](https://keepachangelog.com/);
this project does not yet publish semver releases, so entries are grouped by
work period. Schema changes are cross-referenced to [`MIGRATIONS.md`](MIGRATIONS.md).

**Note on versions:** `package.json` declares `0.1.0` while `docs/RELEASE-1.0.0.md`
exists. The manifest and the release note disagree; reconcile before any release
automation depends on the manifest.

---

## Unreleased — worktree batch: allocation, exposure, pagination, §67

### Fixed — a live PII leak, and the collections queue crashing at volume

**Notification bodies were written to stdout in every environment.**
`MockNotificationProvider` logged the recipient and the full body — borrower
name, outstanding balance, due date, plus password-reset links and co-maker
consent tokens. A reset link in a log file is a live credential. Three things
compounded: `console.log` bypasses pino so none of the eight `redact` paths
applied; both tenant provider builders discard their config and return a mock,
so real credentials did not route around it; and neither `twilio` nor
`@sendgrid` is in any `package.json`, so every notification path terminates
there. Now logs a masked recipient and a body length. `libs/notifications` had
no test target at all; it has one now, and the regression test was proven by
reverting to the old implementation.

**Separately, and still open: no email or SMS has ever been delivered.** The
system stores and masks Twilio and SendGrid credentials for providers that do
not exist. Borrowers receive no payment-due or overdue reminders. That needs a
provider decision and credentials.

**The collections queue hard-failed above ~16,000 overdue accounts.** It named
every queue loan twice — `in` on customerIds plus `notIn` on loan ids —
sending 44,276 bind variables against Postgres' 32,767 cap and returning
P2035. Not a slow response: a hard failure, pre-existing, invisible because no
test had crossed the threshold. Found only by seeding realistic volume.

### Added — configurable payment allocation (§26), which moves nothing yet

All four tiers and three orders are implemented, and not one peso moves — the
finding rather than a shortcut. **Fees are never owed as a balance**
(processing, DST and origination are netted out of disbursement proceeds), and
**penalties are half-modelled**: accrual is real and per-instalment, but there
is no collected-to-date figure per instalment and loan-level waivers cannot be
attributed back to a row. Wiring the tier up without the former would
re-collect the same penalty on every partial payment. A test asserts the three
orders agree, so it fails the day the balances become real.

Order is **snapshotted onto `LoanApplication`**, not read from `LoanProduct`.
Configuring on the product alone would reprice every live loan mid-contract
from a single edit with nothing in the audit trail. A test double throws if the
payment path ever reads the product. All 10 loans and 4 products backfilled to
the legacy order.

§81 held: 42 assertions committed against the unmodified implementation first,
and the allocation golden files are byte-identical across the refactor. §11:
allocation now runs in integer centavos parsed from decimal text — `Number(d)`
was the step being removed, so rounding a double afterwards would not have
counted.

**Reported, not fixed: a borrower cannot pay their late fee at all.**
Allocation only ever credits Loans Receivable by principal, so an accrued fee
leaves only by waiver or write-off.

### Added — consolidated exposure reaches decisioning (§53), inertly

There was **no server-side DTI at all** — the only debt-to-income figure was a
client-side hint against a hardcoded ceiling, sent nowhere, and the engine's
whole view of other debts was a _count_: `4` for a member ₱2.15M in and `4` for
one ₱40,000 in. §16 now runs server-side, with qualifying income and payroll
deductions as explicit zeros stated at the call site rather than hidden.

The shipped ceiling rule is inert twice over — `active: false` **and** a
₱999,999,999 threshold. A sweep across every tier, AML, KYC and principal
combination proves a ₱2.15M borrower and a first-time one get the same action,
rule and version, and pins the uncomfortable case deliberately: a tier-A member
₱2M in is still fast-tracked. When that assertion fails, someone has set a
policy on purpose — which is where §50 says the decision belongs.

### Fixed — the three whole-book reads (F4), with two of my own fixes reverted

Measurement changed the answer three times. Chunking the aging read was **67×
worse** (22,186 → 1,490,394 buffers) because `ORDER BY id` discards the index
serving the filter; chunking the queue bounded nothing. Both reverted. Payloads
over HTTP: queue **84,349,240 → 192,858 bytes**, aging **5,626,737 → 18,116**.

The queue's ranking is unchanged. Scoring within a page was rejected
explicitly: it looks right — sorted, scores attached — while putting the
book's worst account on page 7 ranked first.

### Added — §67 authentication, authorization and idempotency

The spec was **not silent** about authentication; it was wrong in the more
damaging direction. A global `security` requirement meant all 24 anonymous
operations inherited "needs a bearer token", telling integrators that
`/public/leads` and the gateway settlement callback require a JWT. Now
**291 bearerAuth + 13 platformAuth + 24 public + 11 inheriting = 339**.

Idempotency turned out to be three mechanisms, and saying so matters more than
declaring a header everywhere: payments read `Idempotency-Key`; payment intents
read a **body field** and ignore the header, minting a UUID when absent, so
generalising from the first gets you a second intent and no error; webhooks
derive their own. Four §13-relevant routes are not idempotent and now say so —
notably disburse, where a retry is _refused_ 409, because a conditional-update
claim is not idempotency.

### Added — scorecard version history UI (§20)

`catalogVersion` was stamped on every score and read by nothing. The badge shows
the score's **own** version, never the current catalog — the inverse would
defeat the point, so it is tested both ways. A score predating versioning reads
"scorecard not recorded" rather than inventing one.

### Verified — ten phases read against code, with citations

The trackers had gone stale six times; nine more occurrences here, and for the
first time one was stale **pessimistic**. The two documents also contradicted
each other on OpenAPI coverage. Named the mechanism: rows go stale when they
record a **symptom string** — a flag, a count, a quoted line — rather than a
behaviour. The string outlives the fix.

Both §50 negative requirements verified rather than assumed: the assistant has
no tools array, no function-calling and no write path; erasure preserves
financial records.

**Open P1 found: ECL re-runs double-post to the GL.** `postIfAbsent` keys on a
freshly-minted `EclRun.id`, so the idempotency guard never fires, there is no
uniqueness on the period, and the UI tells the operator "This is idempotent —
safe to re-run." Each entry balances internally, so the trial balance still
ties. Not fixed here: `eclProvisionEntry` was owned by another branch this
batch, and it is financial posting code that needs golden tests first.

---

## Unreleased — worktree batch: delete constraints, schedule audit, OpenAPI complete

### Fixed — ten relations that reached money on delete

The matrix's one **DANGEROUS** row named `Contribution`/`SavingsTransaction`,
and both had already been fixed by `20260811160000_coop_money_restrict`. **The
row was stale**, and the briefs that kept scheduling it were reading the matrix
rather than the schema. The class of problem was real and wider than the row.

Eight cascades still terminated in money — `LoanSchedule`, `LoanPayment`,
`PaymentIntent`, `PenaltyWaiver`, `RepossessionCase`, `LeaseAgreement`,
`JournalLine`, `AgentPayoutItem`. The dangerous shape is that deleting a
`LoanApplication` reads like discarding a form and took all of them with it.
Two `SetNull` relations did comparable damage without deleting anything:
`FundTransaction` and `FundWithdrawal` silently **unattributed** coop cash,
leaving money on the books belonging to nobody — the same hole as the earlier
migration, same domain, one column over.

All ten are now `Restrict`, verified `confdeltype='r'` directly in the
database. Thirty cascades were **kept and justified** rather than swept:
assessment and identity rows off `Customer`, activity and governance rows off
`LoanApplication`, join and config rows meaningless without their parent. What
people did is not what money did. The closest calls are flagged rather than
silently decided — `PromiseToPay` carries an amount but is never posted;
`AmlScreening` is regulated but is not money.

Compliance erasure is unaffected: `eraseCustomer` never deletes, it overwrites
PII in place and stamps `erasedAt` precisely so financial relations keep
resolving.

Also closes the check-then-act window our own F2 work exposed: a **partial**
unique index on `BankStatementLine(matchedType, matchedRefId)` where both are
non-null, so nothing at the database level lets one payment be matched to two
statement lines. Hand-written and deliberately not declared in `schema.prisma`
— Prisma skips partial indexes at introspection, and a plain `@@unique` would
reintroduce the phantom drift `e10f06a` just repaired. `migrate diff` still
reports **"No difference detected."**

### Verified — the schedule-immutability audit row was wrong

"Immutable schedule versions" sat at NEEDS VERIFICATION / P1 since Phase 0,
claiming schedule rows mutate on restructure. They do not. The contractual
columns — `installmentNo`, `dueDate`, `principalDue`, `interestDue`,
`totalDue` — are written once by the `createMany` at disbursement and never
assigned again; all six UPDATE sites write only `paidInFullAt`,
`principalPaid`, `interestPaid`, which are servicing columns and are supposed
to move. Re-checked at integration by printing every `data` block.

The audit misread `restructure`, which does run UPDATEs — but they settle the
_original_ loan before minting a wholly new `LoanApplication` linked by
`restructuredFromId`, which grows its own schedule at its own disbursement. The
versioning the row asked for already exists; it lives at the loan level, not
the schedule level, which is why looking at `LoanSchedule` never found it.

19 characterisation tests pin this, proven non-vacuous by temporarily teaching
`restructure` to write `dueDate`: exactly four fail.

One smaller finding recorded rather than fixed: force settlement writes
`principalPaid := principalDue`, so a part-paid instalment loses the split of
what was actually paid. The aggregate survives on the settlement journal entry,
but `auditLoan` refuses to replay force-settled loans, so nothing derives it
today. P3 — and schedule versioning would not have addressed it.

### Added — OpenAPI coverage complete

**328 of 339** operations documented; the other 11 are enumerated exceptions.
**410 and 413 join `ERRORS`**, which two earlier batches reported and correctly
declined to patch unilaterally.

The ratchet was **blind to 13 routes**. Its regex matched `app.get(...)`, but
`platform` registers its authenticated control plane on an encapsulated child
instance, so the entire vendor surface counted as one route — the public
login. Counting `(app|scoped)` closes it, and source and spec totals now agree
exactly at 339.

The companion "still has an undocumented remainder" test was **converted, not
deleted**. Its own comment said to delete it once everything was documented,
but it would never have fired: eleven routes can take no schema, so
`registrations > DOCUMENTED` stays true forever and it would have gone on
reporting a finished job as unfinished. It now asserts the gap is exactly 11
and fails in both directions.

A 403→400 regression was caught by the existing suite and fixed:
`requirePermission` is inherently a `preHandler`, so attaching body schemas
made three routes answer 400 before the permission gate. Worth recording that
the 401 fix (`authenticate` at `onRequest`) does **not** generalise to 403.

---

## Unreleased — worktree batch: object storage, OpenAPI, N+1

### Added — object storage, with local disk still the default

`libs/storage` exposes put/get/getStream/delete/exists — five methods derived
from the four places the codebase actually touches stored bytes, not from what
S3 offers. There is deliberately **no `getSignedUrl`**. `/uploads/` carries a
`sandbox` CSP and `nosniff` precisely because uploads are attacker-influenced
bytes on a same-origin path; a bucket-signed URL points the browser at an
origin where neither header exists and the provider picks the Content-Type. So
bytes leave through the API in both modes, and the signing that already existed
— an HMAC over the `/uploads/` route, not over a bucket object — is unchanged.

No new dependency: `@aws-sdk/client-s3` would pull ~40 transitive packages for
four verbs of plain HTTP on one object. SigV4 is ~90 lines of `node:crypto`,
pinned against AWS's published _GET Object_ vector — canonical request,
string-to-sign and signature all match, with no network, credentials or bucket
involved.

Storage keys are the stored URL minus `/uploads/`, so **no migration**: the
roadmap's flagged "high risk — data migration of existing files" does not
exist, and populating a bucket is a file copy.

Verified on the merged tree: unsigned GET 403; signed GET 200 carrying the full
sandbox CSP, `nosniff` and `accept-ranges`; percent-encoded traversal 403.

`backup.sh` changed and had to. Its old comment claimed object storage "has its
own replication" and needed no backup — wrong in its dangerous half, since
durability protects against hardware failure, not against deletion, a bad
migration, or ransomware, all of which replicate faithfully. Under
`STORAGE_DRIVER=S3` the script now says loudly that it does not cover uploads
instead of tarring an empty directory and reporting success.

**Not yet switched on.** The S3 adapter has never run against a live endpoint;
a bucket, a scoped IAM principal, a file copy and a real round-trip remain.

### Fixed — the three documented N+1 loops (F1–F3)

Reported-not-fixed last batch because each changes financial posting or
reporting code. §81's order held: 38 golden tests committed in three commits
**before** the refactor, verified passing against the unmodified code, then
passing unchanged after it.

- **F1** — the nightly accrual's per-instalment lookup becomes one chunked
  batched read: **8,281 queries and 169s down to 17 queries and 1.35s (125×)**,
  output byte-identical at 2,556 entries. `postIfAbsent` is untouched — the
  batched read computes the delta, it does not guard the insert, so the unique
  index still arbitrates. A second run posted 0.
- **F2** — **the prescribed fix was wrong, and checking it caught that.**
  `claimedRefIds` reads the very columns the loop writes, so the set is
  per-line invariant but _not_ loop invariant. Freezing it fails four golden
  tests: a payment double-matched, a disbursement double-matched, and a later
  line losing a match an earlier claim should have enabled. Re-proved at
  integration by freezing the sets by hand — exactly those four fail. Read once
  and maintain incrementally instead: 2 queries rather than 2N, same answers.
  Separately reported: there is no unique constraint on
  `(matchedType, matchedRefId)`, so the old per-line re-read was never a
  guarantee either — closing that needs a schema change.
- **F3** — `ledgerLines` stops materialising every journal line ever written
  and uses `groupBy`; 3,165 ms and 800k rows spilling 5,259 temp blocks becomes
  888 ms and 5 rows. §11 holds because the columns are `Decimal(14,2)` and the
  builders `round2` after every line.

Three latent oddities were pinned rather than absorbed: `accountBalance`
accumulates in float and returns `-66.66999999999999` (both callers wrap it in
`round2`, and the SQL path lands on the identical double, so nothing moved);
`buildTrialBalance` leaks an internal `net` accumulator into rows its own type
does not declare; and `accruedPenaltiesFor` had no coverage at all despite
three API consumers.

### Added — OpenAPI: the remaining nine feature groups

291 of 339 operations carry a real response shape (was 240). `authenticate`
moved to `onRequest` in eight groups. **co-maker stays public**: a borrower's
co-maker has no account, the invite token _is_ the authorization, and an
unauthenticated POST correctly reaches body validation — 400, not 401.

`PUT /system/notification-providers` is the find worth keeping: its own comment
promised the masked provider view "so the UI can refresh from the response
without an extra round-trip", and the handler has only ever sent `{ ok: true }`
with an `X-Refresh-Needed` header. A schema written from the comment would have
passed every test while publishing a body the route has never sent. The schema
follows the code; the comment was corrected.

Known mechanism gap, reported not patched: `ERRORS` has no **410** or **413**.
All four co-maker routes answer 410 for a lapsed invite — meaningfully distinct
from 404, since the link was real — and the upload route answers 413 over the
size cap. Both left undeclared rather than hand-rolling a second error
envelope.

---

## Unreleased — worktree batch: OpenAPI, drift repair, profitability

### Added — product profitability (§54 / GAP-30)

Per product, over a period: interest, fees, late fees, write-off losses,
net. Journal entries carry no product tag, so attribution reuses the
`(source, sourceRefType, sourceRefId)` tuple the idempotency index and the
reconciliation joins already depend on, resolved to loans in bulk rather
than per row. `REVERSAL` entries inherit both the attribution and the
classification of the entry they reverse — including when the original
falls outside the window — so a correction cancels instead of
double-counting. Entries resolving to no product land in an
`unattributed` bucket that is included in the totals, never dropped.

Cost of funds, opex allocation, agent commissions, bad-debt recoveries and
ECL are out of scope and the file header says so rather than inventing
figures: the book has no data for the first two, and the rest are separate
lifecycles.

Verified at integration against independent SQL: interest 12,285.42, fees
11,375.00, write-offs 50,000.00, net −26,339.58, 0 unattributed — every
figure matching, and `loanCount` 7 being exactly the disbursed loans of
the ten in the book.

### Fixed — schema/migrations drift, all five items, zero DDL

The two indexes that looked missing were phantom drift: their migrations
built them as **partial** indexes, which `@@index()` cannot express and
Prisma introspection ignores, so plain declarations diffed as absent
forever against indexes present in every database. The declarations are
gone, with comments naming the owning migrations. The posting-idempotency
index keeps its real name by declaration (`map:`), because `name:` only
names the client API field — zero DDL against the §13 constraint. Plus two
items the first measurement missed: `Lead`'s DESC sort, and the
`text_pattern_ops` annotation, which Prisma 6 cannot introspect and which
therefore diffed as a perpetual drop/recreate.

`migrate diff --from-migrations --to-schema-datamodel` now reports **"No
difference detected."**

### Added — OpenAPI: portal, cooperative, dorsi, repossession, agents

240 of 339 operations now carry a real response shape (was 174).
`authenticate` moved to `onRequest` in all five groups; portal needed no
special handling after all — it uses the same `app.authenticate`, and the
borrower-vs-staff split lives in `PortalController.guard`, which is
untouched. Two routes left undocumented on purpose: portal's `ledger.pdf`
returns bytes, and dorsi's board-approval can answer a literal `null`.

### Fixed — a duplicate portal KYC upload is a 409, not a 500

The staff KYC route has always mapped `KycDuplicateError` to 409. The
portal route never caught it, so a borrower re-uploading a document they
had already sent got a 500 — an ordinary action reported as a server
fault. Detected by the error's `code` field rather than `instanceof`,
since pnpm can resolve two copies of `@loan/db` and an `instanceof`
spanning them fails silently; one of the three tests pins that case with a
foreign class of identical shape.

---

## Unreleased — worktree batch: write E2E, OpenAPI, indexes, Next pilot

### Added — the write E2E journey

Apply → two-person approval chain → disburse → record payment, all through
the UI, closing with a reconciliation run against a scratch database the run
creates and drops. The write project is not even defined unless
`E2E_WRITE_DB_URL` is set or `--project=write-journey` is typed, so the
default suite neither runs it nor grows a skip. Dev database proven untouched
across every run (`JournalLine` 79 before and after). It found one real
defect (the KYC gate below) and one UI paper cut: the record-payment amount
input steps by whole pesos, so it cannot tender the centavos its own ledger
asks for.

### Added — OpenAPI: auth, rbac, payments, loan-products, delegations

174 of 338 operations now carry a real response shape (was 112), ratcheted.
`authenticate` moved to `onRequest` in every group touched, verified live:
unauthenticated + malformed body answers 401, the same request with a token
answers 400 — so the schemas are active and authorization still wins.
Login/register/refresh and the password-reset routes keep undeclared request
bodies deliberately; a body schema would reinstate the 400-before-401 those
designs exist to avoid.

### Added — six indexes, from captured plans (`20260813090000`)

Measured on a seeded 1.3M-row scratch book, buffer counts as the metric.
Each index ships with its before/after `EXPLAIN` in
`docs/modernization/query-performance.md`; five candidates were rejected with
reasons, and four slow paths an index cannot fix (N+1 accrual loop,
whole-book reports) are recorded as findings. The `JournalEntry` prefix index
is not a duplicate of the idempotency unique index: under `en_US.utf8` a
default btree cannot serve a LIKE prefix at all — re-proved at integration.
Also documented in MIGRATIONS.md: `prisma/migrations` has drifted from
`schema.prisma`, so `migrate dev` against a real database offers a reset;
use `migrate deploy`.

### Added — Next.js pilot (`apps/marketing-next`)

Side by side with the untouched Vite app; six URLs preserved, static pages
ship zero client JS. The finding that matters for §38: `libs/ui`'s barrel
fails an RSC build (five modules hook at module scope, `index.ts` re-exports
all 29) and its classes are bound to the console's design-token system.
Integration added the one fix three green worktree gates could not have
found: Nx injects the root `.env` (gitignored, so absent in worktrees) into
every task, and its `NODE_ENV=development` made every `next build` prerender
crash; the build script now scrubs it.

---

## Unreleased — modernization Phases 0–2

Driven by the enterprise-LMS modernization brief. Audit artifacts live in
[`docs/modernization/`](docs/modernization/README.md).

### Fixed — financial correctness (P0)

Four defects that could each cost money silently. All four shared one root
cause: a check followed by an action, with nothing preventing a second request
from arriving in between. All four are now enforced by the database.

- **Journal entries could double-post.** `postIfAbsent` read for an existing
  entry and posted if it found none, with only an index behind it. Two
  concurrent callers both found nothing and both posted; each entry balanced on
  its own, so the trial balance still tied and no check could see the duplicate.
  Now `UNIQUE(source, sourceRefType, sourceRefId)` with insert-and-catch.
  (`64e17ff`, migration `20260811120000`)
- **Disbursement, early closure and write-off were check-then-act.** Two
  concurrent disbursements could both pass an `APPROVED` guard and both post cash
  movements. Transitions are now claimed with a conditional `UPDATE … WHERE`.
  (`fa5e3fb`)
- **A retried payment charged the borrower twice.** No duplicate detection
  existed; a timeout, a double-submitted form or an at-least-once provider
  callback each created a second real payment. Added `LoanPayment.idempotencyKey`
  (unique) and an `Idempotency-Key` header; a repeat replays the original.
  (`7564fa8`, migration `20260811130000`)
- **A disbursed loan could be decided again.** `decide()` had no status guard at
  all — a funded loan could be rewound to APPROVED or flipped to REJECTED with
  the money already out. Now claimed, while preserving the documented
  reconsideration flow (`REJECTED → APPROVED`). (`128b7b2`)
- **Loans could reach APPROVED with an incomplete KYC file.** Two paths lead to
  APPROVED and only one of them checked. `decide` validates KYC documents and
  required declarations — and, once the approval chain was enforced, refuses
  outright while steps are pending. That refusal was right, but it made the
  chain the _only_ route to APPROVED for any product that has one, and
  `LoanApprovalRepository.approveStep` flipped the loan on the final signature
  without looking at KYC at all. The gate did not degrade to advisory; for
  chained products it became unreachable, while `decide` still carried the
  comment saying approval re-checks it. Every seeded product has a chain, so
  the unchecked path was the ordinary one. The final step now runs the same
  two checks inside the claim transaction, with the same `overrideKyc` escape
  hatch, recorded in the step notes. Found by the write E2E journey.

### Fixed — jobs

- **A slow job restarted itself.** `nextRunAt` advanced only after a job
  finished, and `setInterval` does not wait for an async tick, so any job slower
  than the tick interval began again on top of itself — on a single process, no
  scaling involved. Slots are now claimed by compare-and-swap before the job
  runs. (`6359027`)

### Added — tests

- **26 financial invariants** across `libs/accounting` and `libs/loans`: entry
  balance for all 20 builders, reversal netting, allocation conservation,
  interest recognised once across partial payments, non-negative ledger
  positions, per-loan flooring. (`e1620a1`)
- **Golden corpus** — 8 scenarios, 49 assertions, split into closed-form
  VERIFIED values and implementation-captured CHARACTERIZATION fingerprints.
  (`5ff6f68`)
- Idempotency, job-slot and decision suites alongside each fix.

### Added — features

- **Customer archiving** replaces deletion. A customer anchors loans, payments
  and ledger lines, and `Contribution`/`SavingsTransaction` cascade — so
  deleting a coop member who had saved for years but never borrowed would have
  destroyed their money records. (`3a9d0fa`, migration `20260808150000`)
- **Data Privacy page** — DSAR export, erasure with a receipt naming cleared
  fields and retained tables, retention policy with the AMLA five-year floor
  warning, and manual purge. The API existed and had no UI. (`062474f`)
- **Staff deactivation** — `User.active` was read at login and refresh but no
  endpoint could write it. Deactivating now also cuts live sessions. (`fbb98a0`)
- Erased-customer badges, banners and server-side guards at both service and
  repository layers. (`a2937ef`, `e803344`, `290cf18`)
- **Standing reconciliation** — a nightly job asserting five ledger identities,
  including GL Loans Receivable against outstanding principal. It throws on a
  finding so the run shows FAILED rather than succeeding with a note nobody
  reads. Found a real disagreement of ₱46,272.02 on its first run, traced to
  smoke-test fixtures that credited the receivable for a written-off loan while
  leaving its instalments open. (`515d26f`)
- **Decision-rule versioning** — rules were one mutable row each, so retuning a
  rule destroyed the only copy of what it used to say, and retuning is the
  entire reason the criteria live in a table. Every change now closes the
  standing version and opens the next; a decision records the rule id, name,
  **version** and the full context the engine saw. `GET /decision-rules/as-of`
  rebuilds the whole set at a moment. Only outcome-changing edits mint a version
  — a rename does not, so the history stays worth reading. DELETE retires rather
  than erases. (migration `20260811180000`)

### Fixed — other

- Presence showed a signed-out user as **Online** for the rest of the window;
  `presenceOf` now accounts for session revocation and account status.
  (`c2a85f4`, `a2a8b11`)
- A partial question patch could **silently unask a scoring question** — the
  kind/config cross-check only saw the fields it was sent. (`b0697d4`)
- The dev proxy targeted `localhost`, which resolves to IPv6 first; another
  project's server on `[::]:3001` was answering every API call with a truthful 404. Pinned to `127.0.0.1`. (`4cf5a0b`)

### Added — frontend tests

The web app had one test file against 148 components. It now has a harness
(jsdom + Testing Library, `apps/web/src/test/`) and four suites chosen by
consequence rather than by coverage percentage — the erased/archived customer
guards, the "Sign out everywhere" gate, the decision-rule version history, and
`usePermission` failing closed. 45 tests.

Writing them found two real accessibility defects, both fixed: the rule version
badge announced only "v3" to a screen reader, and the rule editor's labels were
not associated with their controls. Nine other copies of the same `Field`
helper share the second defect and are flagged for a follow-up.

**E2E followed**: Playwright, six journeys, 21 assertions against a live API —
auth, RBAC, customer list and detail, decision-rule version history, and the
loan schedule's arithmetic checked against what the DOM actually shows. They
exist for the one thing component tests cannot do: catch the API and the page
disagreeing about a shape.

Writing them surfaced two things worth recording. The login route is throttled
at 10/minute and signing in per test tripped it — fixed in the suite (sessions
saved once per role and reused) rather than by weakening a real control. And
`apps/web/e2e/` was invisible to both `tsc` and ESLint until added to the
tsconfig.

Every journey reads. Nothing covers apply → approve → disburse → pay, because
doing that against the shared development database would drift the ledger a
little on every run. That needs a disposable database per run, which is the
next piece of work rather than something to fake with cleanup code.

### Added — scorecard versioning

The decision-rule question applied to credit scores, and narrower than the
audit claimed. `CreditScore.breakdown` already froze each factor's label,
resolved maxPoints, achieved weight and points — a stored score already said
what it was made **of**. What it could not say was what it was made **by**:
whether two scores are comparable, what the questions offered before someone
edited an option's weight, which factors were switched off, or who changed the
scorecard and when.

`ScoringCatalogVersion` snapshots the **whole** catalog per version, not one
row per factor. That difference is forced rather than chosen: points normalize
against a fixed 150-point total, so raising one factor's weight lowers every
other factor's points — there is no edit that touches one factor. The snapshot
is stored in the shape `@loan/credit-scoring` consumes, so replaying a
historical scorecard is a function call rather than a reconstruction.

Baseline minted at boot rather than by the migration, because the snapshot has
to include the shipped-catalog fallback. Read endpoints are `scoring.read`, not
admin — an officer explaining a score needs the scorecard that produced it.

No UI yet: the history is reachable by API only. (migration `20260812090000`)

### Changed — seven aging buckets

`buildAgingReport` stopped at `D_90_PLUS`, which put a loan 95 days late in the
same row as one three years gone. Those are different assets with different
provisioning and different collection decisions, and a report that cannot tell
them apart supports neither. Now the §28 bands: Current, 1–30, 31–60, 61–90,
91–120, 121–180, 180+. Upper bounds inclusive, so 90 days is still `D_61_90`
and 91 is the first non-performing day — the direction that does not flatter
the book.

Report-only, which is why it needed no migration: nothing persists a bucket and
nothing computes money from one. ECL stages independently on days-past-due, so
this moved no provision and restated no ledger.

Two hand-maintained lists became derived along the way — the report order now
comes from the label `Record` the type makes exhaustive, and portfolio-at-risk
sums by excluding `CURRENT` rather than by naming the overdue bands. Both were
guarding the same failure: a band added later that renders in the table while
dropping out of the total above it.

### Added — Content Security Policy (API)

Set by hook rather than by helmet, because one global policy cannot serve
JSON, Swagger UI, and uploaded files at once. JSON responses get
`default-src 'none'`; `/docs` is exempt; `/uploads/` gets `sandbox`.

The uploads policy is the one with a real vector behind it. Uploaded files are
served same-origin, and `branding` — admin-writable, and public because the
logo renders on the login screen — accepts `.svg`. `sandbox` makes a served
file its own opaque origin with scripting off: it still renders, and it can no
longer touch the session that opened it. It governs direct navigation, not
`<img src>`, so previews are unaffected — verified in the browser.

The SPA still has no CSP. It is served by Vite in development and a static host
in production, neither of which this hook touches; that one is a deployment
change.

### Added — OpenAPI response schemas (mechanism + first slice)

The generated spec had **336 operations and zero response schemas** — every
one "Default Response" with no shape. It also declared no authentication, so
`/docs` rendered a "Try it out" button that could only ever return 401.

Hand-writing 336 schemas would create a second description of every payload,
and the second one goes stale silently. So `apps/api/src/lib/openapi.ts`
derives them: requests from the zod schemas the routes already validate with,
responses declared as zod beside them, errors as shared components with the
409 convention spelled out (well-formed, permitted, and refused by the
target's state — retrying unchanged will not help).

**Coverage is 10 of 336**, and a test ratchets it so it cannot fall and so
nobody reads "OpenAPI: done" off a green suite. The global additions — bearer
scheme, status-code conventions, money-as-string note — improve all 336.

Two bugs found by doing it, both the same shape. Fastify does not just publish
a response schema, it _serialises_ against it and strips undeclared fields, so
an incomplete schema silently deletes data. Fixed with recursive
`additionalProperties: true` — and then the identical bug turned up in the
error schemas themselves, where `issues: { items: { type: "object" } }` reduced
every validation issue to `{}`. Also, attaching request schemas made Fastify
reject bad input with a bare `{"error":"Bad Request"}` instead of the
controllers' `{ error, issues }`; a schema error formatter restores the
contract and now names the failing field.

### Added — documentation

- Phase 0 audit: nine artifacts plus a gap matrix, recommended architecture and
  roadmap.
- The §85 reference set: architecture, database, financial-engine, credit-engine,
  collections, accounting, security, compliance, testing, disaster-recovery.
- This file and `MIGRATIONS.md`.

### Known open items

Carried in [`docs/modernization/gap-matrix.md`](docs/modernization/gap-matrix.md):

Every P0 is closed, and so is every P1 except the frontend one.

No P0 or P1 remains open.

- **P2** — a write E2E journey (apply → disburse → pay), which needs a
  disposable database per run; scorecard (`SurveyCatalog`) versioning, the same
  argument as decision rules applied to factor weights; object storage for
  uploads, now planned work rather than urgent since the backup script archives
  `UPLOADS_DIR`; seven aging buckets rather than five; OpenAPI response
  schemas; CSP; Nx module-boundary tags
- **P2** — scorecard (`SurveyCatalog`) versioning, the same argument as
  decision rules applied to factor weights; seven aging buckets rather than
  five; OpenAPI response schemas; CSP; Nx module-boundary tags

Two things only a deployer can do: set `UPLOADS_DIR` in the environment, and
supply a real amortization schedule from a signed loan document so the golden
corpus becomes authoritative rather than self-consistent.
