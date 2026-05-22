# API features — layering registry

Live map of which features have which layers, and why. The architecture
contract is `docs/architecture.md`; this file is the running scoreboard.

## Layering decision per feature

| Feature            | Routes      | Controller   | Service      | Schemas | Helpers | Notes                                                                                                                               |
| ------------------ | ----------- | ------------ | ------------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **auth**           | ✓           | ✓            | ✓            | ✓       | ✓       | Full split — security-critical, every endpoint audit-coupled                                                                        |
| **customers**      | ✓           | ✓            | ✓            | ✓       | ✓       | Full split across 3 sub-surfaces (base / bulk-import / ledger)                                                                      |
| **kyc**            | ✓           | ✓            | ✓            | ✓       | —       | Full split — dedup error class + status rollup orchestration                                                                        |
| **dorsi**          | ✓           | ✓            | ✓            | ✓       | —       | Full split — audit-coupled tag/deactivate/review                                                                                    |
| **loans**          | ✓           | ✓ (workflow) | ✓ (workflow) | ✓       | —       | Workflow paths (apply/decide/disburse/dry-run) layered; the 25 other endpoints stay inline. Approvals = separate sub-feature triad. |
| **accounting**     | ✓           | ✓ (journal)  | ✓ (journal)  | ✓       | —       | Journal write paths layered; COA, reads, reports, periods, accrual job stay inline                                                  |
| **loan-products**  | ✓           | —            | —            | ✓       | —       | Pure CRUD; no orchestration to extract                                                                                              |
| **payments**       | ✓           | —            | —            | ✓       | —       | Provider webhook orchestration lives in `PaymentIntentRepository.handleWebhook` (libs/db) — routes are thin adapters                |
| **annual-docs**    | ✓           | —            | —            | ✓       | —       | Schemas only — repo is the orchestration boundary                                                                                   |
| **assistant**      | ✓           | —            | —            | ✓       | —       | Schemas only — prompt templates + repo calls only                                                                                   |
| **reconciliation** | ✓           | —            | —            | ✓       | —       | Schemas only — bank-statement repo holds state machine                                                                              |
| **system**         | ✓           | —            | —            | ✓       | —       | Schemas only — idle policy + branding upsert                                                                                        |
| **portal**         | ✓           | ✓            | ✓            | ✓       | ✓       | Full split — borrower-scoped ownership enforcement + CSV/PDF dispatch                                                               |
| **rbac**           | ✓           | ✓            | ✓            | ✓       | —       | Full split — user create with conditional customer-link rule + ADMIN self-lockout guard                                             |
| **repossession**   | ✓           | ✓            | ✓            | ✓       | —       | Full split — 8 state transitions, all audit-coupled, auction posts the settlement journal                                           |
| **demand-letters** | ✓           | ✓            | ✓            | ✓       | —       | Full split — FRD §3.6.5 stage-gated approval + segregation-of-duties + best-effort dispatch notifications                           |
| **reports**        | ✓           | ✓            | ✓            | ✓       | —       | Full split — 6 builder dispatch + JSON/CSV format dispatch on the HTTP edge                                                         |
| **cooperative**    | ✓           | ✓            | ✓            | ✓       | —       | Full split — 7 entity types, GL auto-post happens inside the repo                                                                   |
| **delegations**    | ✓           | ✓            | ✓            | ✓       | —       | Full split — permission gate on contents + delegator-vs-caller authority + extend-after-revoke check                                |
| **lease**          | ✓           | ✓            | ✓            | ✓       | —       | Full split — 4 state transitions; buyout posts a journal entry                                                                      |
| **documents**      | ✓           | ✓            | ✓            | ✓       | ✓       | Full split — agreement / statement / receipt + portal mirror; signature loading + ownership scoping                                 |
| **audit**          | ✓           | ✓            | ✓            | ✓       | —       | Full split — read-only API; writes still inline from feature services                                                               |
| **collections**    | ✓           | ✓            | ✓            | ✓       | —       | Full split — notes + PTPs + late-fee accrual; accrual surfaces 409 on closed-period                                                 |
| **decision-rules** | ✓           | ✓            | ✓            | ✓       | —       | Full split — rule CRUD + 409 on unique-name conflict                                                                                |
| **ecl**            | ✓           | ✓            | ✓            | ✓       | —       | Full split — period-default rules + audit-coupled recompute                                                                         |
| **scoring**        | ✓           | ✓            | ✓            | ✓       | —       | Full split — survey submit orchestrates `computeCreditScore` + save + upsert latest                                                 |
| **health**         | ✓           | —            | —            | —       | —       | Liveness/readiness — no auth, no body, no orchestration                                                                             |
| **jobs**           | ✓ (factory) | —            | —            | —       | —       | Factory plugin — admin routes for the scheduler; scheduler itself is platform-wide (P2.11 makes it per-tenant)                      |
| **notifications**  | ✓           | —            | —            | —       | —       | Admin routes + `app.notifications(prisma)` factory decorator for per-tenant `NotificationRepository`                                |
| **screening**      | ✓           | —            | —            | —       | —       | Admin routes + `app.screening(prisma)` factory decorator for per-tenant `ScreeningRepository`                                       |
| **uploads**        | ✓           | —            | —            | —       | —       | Multipart → disk → URL; orchestration lives in `@fastify/multipart`                                                                 |

## Rationale

Every feature route module is layered: routes → controller → service →
schemas. Uniformity > minimalism — a new contributor learns one layout
and finds the same pieces in the same places. Where a service is a
near-empty pass-through (e.g. `audit`), the layer still earns its keep
as the seam where future orchestration lands without a feature-shape
rewrite.

The four exceptions are not feature routers:

- **health**: liveness/readiness; no auth, no body, no future
  orchestration imaginable.
- **jobs**: factory plugin that decorates `app.jobs` with the
  scheduler (cron-driven background jobs) and exposes admin routes
  for inspecting runs. The scheduler itself is platform-wide today;
  the per-tenant outer loop lands in P2.11.
- **notifications**, **screening**: admin route plugins + per-tenant
  factory decorators (`app.notifications(prisma)`,
  `app.screening(prisma)`). Callers build a fresh repo per request
  using `req.tenantCtx.prisma` so reads and dispatches stay scoped to
  the calling tenant's schema. Provider singletons (Twilio, SendGrid,
  AML clients) are shared across tenants.
- **uploads**: multipart streaming where `@fastify/multipart` owns the
  orchestration and the route is a thin disk-write adapter.

The architecture doc (`docs/architecture.md`) still defines what each
layer is for — that contract hasn't changed. What changed is that
"earn its keep" used to also gate whether the layer exists; now it
only gates how much logic the layer holds.

## When to upgrade a feature

If you find yourself adding orchestration to a flat feature (e.g., a
second repo call, an audit write, a fan-out notification), promote it
to the layered structure following the customers/ canary at the same
time. Routine pattern:

1. Extract the inline zod schemas into `schemas.ts`.
2. Create `<feature>.service.ts` with a class whose methods are the
   business operations.
3. Create `<feature>.controller.ts` as the HTTP adapter (zod parse →
   service call → response shape).
4. Slim `<feature>.routes.ts` to declaration-only.
5. Wire the chain in `<feature>.routes.ts` (or `index.ts` if you want
   a separate composition root).
6. Build + verify (`pnpm --filter @loan/api build`).
7. Update this README's table.

## Adding a brand-new feature

See `docs/architecture.md` § "How to add a new feature".
