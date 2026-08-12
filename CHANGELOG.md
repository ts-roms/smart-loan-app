# Changelog

Notable changes to Smart Loan. Format follows [Keep a Changelog](https://keepachangelog.com/);
this project does not yet publish semver releases, so entries are grouped by
work period. Schema changes are cross-referenced to [`MIGRATIONS.md`](MIGRATIONS.md).

**Note on versions:** `package.json` declares `0.1.0` while `docs/RELEASE-1.0.0.md`
exists. The manifest and the release note disagree; reconcile before any release
automation depends on the manifest.

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
