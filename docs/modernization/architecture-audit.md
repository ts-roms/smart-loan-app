# Architecture Audit

See `repository-audit.md` §A for the measured shape. This document records
judgements about it.

## The layering already matches the target

The brief proposes `Route → Controller → Service → Repository → Prisma → PostgreSQL`
as a goal. It is the existing structure. Controllers are thin (zod-parse, call a
service, map a discriminated-union result to an HTTP code); business logic lives
in services and `libs/*`; Prisma access is confined to `libs/db/src/repositories`.

**Recommendation: no structural refactor.** Effort is better spent on the
guarantees in `financial-engine-audit.md` than on rearranging layers that are
already correct.

## The Fastify → NestJS question

**Do not migrate.** The brief already leans this way (§6) and the evidence
supports it:

- The stated benefit of NestJS is DI plus enforced layering. Both are present:
  the per-request service container (`buildCustomerServices` and its siblings) is
  hand-rolled DI, and it is _better_ than the framework default for this system
  because it binds every service to a tenant-scoped Prisma client — the property
  that makes cross-tenant leakage structurally impossible rather than merely
  discouraged.
- A framework migration touches all 319 route registrations and every controller
  while changing no observable behaviour: maximum regression surface, zero
  user-visible gain, on a system holding financial records.

## Where the architecture is genuinely weak

**A-1 (P2) — no enforced module boundaries.** Nx tags and the
`enforce-module-boundaries` lint rule are not configured, so nothing structurally
prevents a UI package importing a repository. With 18 libs this matters.
Recommend tags along `type:app|feature|domain|util` and `scope:api|web|shared`,
then turn the rule on. Cheap, and it makes the layering self-enforcing.

**A-2 (P3) — `libs/db` carries two responsibilities.** It holds repositories
(storage) _and_ infrastructure utilities (`multi-tenant-migrate`,
`adopt-existing`, `repair-payment-allocations`, `dorsi-helpers`). Splitting the
operational tooling into its own package would clarify ownership. Cosmetic;
do it opportunistically, not as a project.

**A-3 (P3) — per-request service wiring is duplicated per feature.** Each feature
has its own `buildXServices` preHandler. Consistent and readable, but
copy-adapted, so improvements to one do not propagate. A shared factory would
reduce drift.

**A-4 (observation) — the brief's own lib inventory is stale**: it omits
`libs/accounting`, which exists and is central. A reminder that the repository,
not the brief, is the source of truth.

## Three frontends, one design system

`apps/web`, `apps/platform` and `apps/marketing` are all Vite SPAs sharing
`libs/ui`, `libs/api-client`, `libs/shared-types` and `libs/shared-utils`. That
sharing is exactly what makes any future frontend migration tractable — see
`nextjs-migration.md`.
