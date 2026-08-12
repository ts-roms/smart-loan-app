# Browser E2E

Six journeys through the real UI against a real API.

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

The cost is real — no journey covers apply → approve → disburse → pay,
which is the flow most worth covering. Doing that properly needs a
disposable database per run, and that is the next piece of work here,
not something to fake with cleanup code that fails halfway and leaves
the ledger worse than no test at all.

## Conventions

- `data-testid` only where a role query genuinely cannot express the
  target. A test that can ask for `getByRole("button", { name: ... })`
  is also asserting the control is reachable; a testid asserts nothing.
- 127.0.0.1, never `localhost`. It resolves to `::1` first on some
  machines, and this repo has already lost an afternoon to another
  project's server answering on `[::]:3001` (`4cf5a0b`).
