# Browser E2E

Six read-only journeys through the real UI against a real API — plus
one WRITE journey against a disposable database (see below).

## Why these exist alongside the component tests

The suites under `src/**` mock `@loan/api-client`. That is the right seam
for asking "given this data, does the page render the right thing" — and
it means, by construction, that they cannot catch the failure that
actually bites: **the API and the page disagreeing about a shape.**

Rename a field on the server and every component test still passes. The
column just goes blank in production.

These journeys close that gap and nothing else. They are deliberately
not a second copy of the component suites: no permission-matrix
enumeration, no banner-wording assertions. Those are cheaper and clearer
one level down.

## Running them

The stack has to be up. All of it:

```bash
pnpm dev:up
```

```bash
pnpm dev:license
```

The licence matters more than it looks. Several features sit behind the
gate and return **402**, which reads exactly like an authorisation
failure if you are not expecting it.

```bash
pnpm dev
```

```bash
pnpm --filter @loan/web e2e
```

`00-stack.setup.ts` checks the prerequisites first and fails with a
sentence naming the missing one, so a stack that is half up reads as
that rather than as six mysterious failures.

## What they will not do

**They do not write.** Every journey reads. This is a development
database with hand-built fixtures and a ledger that a nightly job
reconciles; a suite that created loans would drift it a little on every
run, and the drift would land in the reconciliation as a finding
somebody has to investigate.

The cost was real — no journey covered apply → approve → disburse →
pay, which is the flow most worth covering. Doing that properly needs a
disposable database per run, not cleanup code that fails halfway and
leaves the ledger worse than no test at all. That piece of work now
exists:

## The write journey

```bash
pnpm --filter @loan/web e2e:write
```

`write-journey/scripts/run.mjs` creates `smart_loan_e2e_<timestamp>` on the dev
Postgres (:5433), runs migrations + the dev seed + the smoke-test
fixtures against it, boots a dedicated API on :3003 and a dedicated
Vite on :5183 whose proxy targets that API (`vite.config.mjs` — see
the note there on why it is not `.ts`), runs the
`--project=write-journey` spec, and DROPs the database afterwards —
also on failure. The dev stack on :3001/:5173 is neither needed nor
touched; the only shared piece is the Postgres server itself, and
`write-journey/scripts/db-admin.mjs` refuses to create or drop anything that
does not match `smart_loan_e2e_<digits>`, so the dev database is out of
reach by construction.

The journey drives every lifecycle step through the real pages — the
wizard as the officer, both approval-chain signatures (officer, then
admin, because the seeded chain requires two different signatures),
disburse and the payment form as the admin — and closes by running
`runReconciliation`'s five checks directly against the scratch
database. That last assertion is the point: the flow must leave books
that reconcile, not just screens that look right.

Under a bare `playwright test` the write project skips with a sentence
naming this runner. The read suite is unchanged either way.

Expect it to be the slowest suite in the repo: the scratch database
lifecycle plus a cold Vite put a run in the couple-of-minutes range.

## Conventions

- `data-testid` only where a role query genuinely cannot express the
  target. A test that can ask for `getByRole("button", { name: ... })`
  is also asserting the control is reachable; a testid asserts nothing.
- 127.0.0.1, never `localhost`. It resolves to `::1` first on some
  machines, and this repo has already lost an afternoon to another
  project's server answering on `[::]:3001` (`4cf5a0b`).
