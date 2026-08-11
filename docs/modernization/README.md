# Modernization — Phase 0 Audit

Audit of the working copy at `D:\codespaces\commercial\smart-loan-app`
(branch `feat/version-update`, 266 commits). Observation only — no production
behaviour was changed to produce any document here.

## Two sets of documents

**Audit artifacts (§8)** — point-in-time findings, dated 11 Aug 2026. They record
what was found and should not be edited to stay current; they are the historical
record.

**Reference set (§85)** — living documentation of how each subsystem works.
Update these as the system changes.

| §85 reference                                  | §8 audit it draws on                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)           | [`architecture-audit.md`](architecture-audit.md)                                               |
| [`database.md`](database.md)                   | [`database-audit.md`](database-audit.md)                                                       |
| [`financial-engine.md`](financial-engine.md)   | [`financial-engine-audit.md`](financial-engine-audit.md)                                       |
| [`credit-engine.md`](credit-engine.md)         | — (domain not separately audited)                                                              |
| [`collections.md`](collections.md)             | —                                                                                              |
| [`accounting.md`](accounting.md)               | —                                                                                              |
| [`security.md`](security.md)                   | [`security-audit.md`](security-audit.md)                                                       |
| [`compliance.md`](compliance.md)               | —                                                                                              |
| [`testing.md`](testing.md)                     | [`test-coverage-audit.md`](test-coverage-audit.md)                                             |
| [`disaster-recovery.md`](disaster-recovery.md) | —                                                                                              |
| [`nextjs-migration.md`](nextjs-migration.md)   | [`frontend-audit.md`](frontend-audit.md)                                                       |
| [`roadmap.md`](roadmap.md)                     | [`gap-matrix.md`](gap-matrix.md), [`recommended-architecture.md`](recommended-architecture.md) |

Plus [`CHANGELOG.md`](../../CHANGELOG.md) and [`MIGRATIONS.md`](../../MIGRATIONS.md)
at the repository root.

## Read in this order

| Document                                                         | Answers                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`repository-audit.md`](repository-audit.md)                     | What actually exists: architecture, stack, database, capability inventory (brief §86 A–D)     |
| [`financial-engine-audit.md`](financial-engine-audit.md)         | **Start here if you read only one.** The three P0 defects and what is already correct (§86 F) |
| [`modernization-gap-analysis.md`](modernization-gap-analysis.md) | Every target capability, categorised, with risk (§86 E)                                       |
| [`roadmap.md`](roadmap.md)                                       | Sequenced plan, and what I recommend against (§86 H–J)                                        |
| [`nextjs-migration.md`](nextjs-migration.md)                     | Migration assessment and why it should wait (§86 G)                                           |
| [`architecture-audit.md`](architecture-audit.md)                 | Layering judgement; the Fastify/NestJS question                                               |
| [`database-audit.md`](database-audit.md)                         | Schema, money typing, tenancy, FK hazards                                                     |
| [`api-audit.md`](api-audit.md)                                   | 319 routes, validation, authorization, OpenAPI gap                                            |
| [`security-audit.md`](security-audit.md)                         | Controls present, and four gaps                                                               |
| [`frontend-audit.md`](frontend-audit.md)                         | Three Vite SPAs, and the testing hole                                                         |
| [`test-coverage-audit.md`](test-coverage-audit.md)               | 47 files, where they are and what is missing                                                  |

## The short version

**The repository is in materially better shape than the brief assumes.**

- No capability listed in the brief is missing. All of them are built.
- Money is `Decimal` with explicit precision everywhere — 79 columns, zero
  monetary floats. The defect that usually forces a painful migration is absent.
- The layering the brief proposes as a target is the layering that exists.
- Multi-tenancy is schema-per-tenant with a real isolation test. Keep it.
- Security baseline is strong: argon2id, refresh-token re-use detection,
  permission-based RBAC, append-only audit with impersonation attribution.

**Three P0 defects, all the same root cause** — checking a condition and then
acting on it without holding anything that stops a second request doing the same
in between:

1. Journal entries can double-post: `postIfAbsent` is a read-then-write check and
   `(source, sourceRefId)` is an index, not a unique constraint.
2. Payments have no idempotency key: a retry or double-submit creates a second
   real payment and a wrong balance.
3. Disbursement is check-then-act with no row lock (`FOR UPDATE` appears nowhere
   in the codebase), so two concurrent requests can both pass the `APPROVED` gate.

Each fix is small and database-level. Together they are worth more than the
entire framework migration the brief proposes, and they should come first.

**The one infrastructure gap with real consequence:** KYC documents — government
IDs, payslips, selfies — are stored on the API container's local filesystem and
served by the same process. No durability, no lifecycle policy, no signed-URL
expiry, and horizontal scaling breaks document access.

**Deliberate decisions that should not be "fixed":** the in-process job scheduler
(documented trade-off, queue-shaped handlers, needs only an advisory lock before
multi-process deploy) and Fastify (migrating to NestJS would touch 319 routes to
change nothing observable).

## Status

Phase 0 complete. Phase 1 not started — see [`roadmap.md`](roadmap.md).
