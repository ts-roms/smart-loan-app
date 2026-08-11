# Recommended Architecture — §86-H

Derived from the actual repository, not from the target diagram. Where the two
differ, this document explains why the repository wins.

---

## The recommendation in one line

**Keep the architecture. Fix the guarantees.** The layering the brief proposes
as a target is the layering that exists; what was missing were database-level
guarantees, four of which are now closed.

---

## Target

```
apps/web · apps/platform · apps/marketing          React 18 + Vite 6, PWA
        │                                          (Next.js: pilot on marketing only)
        │  REST /api/v1 · zod-validated · Idempotency-Key on money endpoints
        ▼
apps/api — Fastify 5                               41 features, 319 routes
        │
        ├─ routes        requirePermission(key) per route
        ├─ controllers   zod-parse → service → discriminated union → HTTP code
        ├─ services      orchestration; 409 = well-formed but state refuses
        └─ repositories  libs/db — the ONLY place Prisma is touched
        │
        ▼
Prisma 6 → PostgreSQL                              schema-per-tenant
        │
        ├─ UNIQUE constraints          idempotency (journal, payment)
        ├─ conditional UPDATE claims   one-shot transitions (decide, disburse,
        │                              closeEarly, writeOff, job slots)
        ├─ RESTRICT / CASCADE          referential intent, stated in schema
        └─ Decimal(p,s) everywhere     no monetary float, anywhere

  Object storage (S3/MinIO)    ← the one piece genuinely missing
  Advisory scheduling          ← in-process, correct for single-process deploy
  Sentry                       ← wired
```

## The four decisions that define it

### 1. Fastify stays

The benefit claimed for NestJS is DI plus enforced layering. Both exist here,
and the hand-rolled per-request container is _better_ for this system than the
framework default: it binds every service to a **tenant-scoped** Prisma client,
which makes cross-tenant leakage structurally impossible rather than merely
discouraged. Migration would touch 319 route registrations to change nothing
observable, on a system holding financial records.

### 2. Schema-per-tenant stays

Row-level tenancy would be a downgrade. Schema separation makes a leak a
deployment error rather than a forgotten `WHERE`, and there is a test guarding
it (`tenant-isolation.test.ts`). Every migration must fan out; the machinery
exists and is tested.

### 3. Guarantees live in the database, not in application code

This is the architectural principle Phase 1 established, and the one worth
carrying forward:

> A check followed by an action is something a second request can walk between.
> A unique index or a conditional `UPDATE … WHERE` is not.

Concretely — every one of these was a check-then-act, and is now a claim:

| Operation                        | Guarantee                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| Auto-posted journal entry        | `UNIQUE(source, sourceRefType, sourceRefId)`                |
| Payment                          | `UNIQUE(idempotencyKey)`, replay on conflict                |
| Disburse / closeEarly / writeOff | `UPDATE … WHERE status = <expected>`                        |
| Decide                           | `UPDATE … WHERE status IN (decidable) AND status <> target` |
| Scheduled job slot               | compare-and-swap on `nextRunAt`                             |

New financial operations should follow the same shape. The application may read
first for a fast path; it may not treat that read as the guarantee.

### 4. The frontend stays Vite until there is a reason and a safety net

Three SPAs sharing four libraries is not a defect. Migration is gated on an E2E
suite that does not yet exist, and should pilot on `marketing` — public, no
auth, where SSR actually pays — before anything authenticated moves.

## What should change

| Change                             | Why                                                                                                                                                | Priority |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Object storage for uploads         | KYC identity documents on a container filesystem: no durability, no lifecycle, no signed-URL expiry, and horizontal scaling breaks document access | P1       |
| Webhook idempotency                | providers deliver at-least-once; the payment key already exists to reuse                                                                           | P0       |
| Rule + scorecard versioning        | §20/§21 — a decision cannot currently be replayed, because the rule that fired may have been edited since                                          | P1       |
| Contribution/Savings FK → RESTRICT | the schema still permits what the service now refuses                                                                                              | P1       |
| Standing reconciliation job        | turns a manual trial balance into a continuous assertion                                                                                           | P1       |
| Nx module-boundary tags            | 18 libs with nothing preventing a UI package importing a repository                                                                                | P2       |
| Playwright + 6 journeys            | precondition for any frontend work                                                                                                                 | P1       |

## What should NOT change

Fastify. Prisma. PostgreSQL. Schema-per-tenant. The in-process scheduler (a
documented trade-off with queue-shaped handlers, now correct under overlap).
The permission model. The audit trail. The money types. And — until a golden
corpus derived from signed loan documents exists — the arithmetic.
