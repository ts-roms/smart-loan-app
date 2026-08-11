# Database

Living reference. Point-in-time findings: `database-audit.md`.

---

## Shape

**71 models, 52 enums, 65 migrations, 48 unique constraints, 3,373 schema lines.**

Multi-tenancy is schema-per-tenant: `CREATE SCHEMA "tenant_<slug>"`, one Prisma
client bound per request. Do not replace this with row-level tenancy — schema
separation makes a leak a deployment error rather than a forgotten `WHERE`, and
`tenant-isolation.test.ts` guards it.

## Money columns

79 `Decimal`, every one with explicit precision. 5 `Float`, none monetary.
Precision table and rounding rules live in `financial-engine.md`.

## Constraints that carry meaning

| Constraint                                                | Purpose                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `UNIQUE(JournalEntry.source, sourceRefType, sourceRefId)` | auto-post idempotency; NULLs are distinct so manual entries may repeat |
| `UNIQUE(LoanPayment.idempotencyKey)`                      | payment replay instead of a second charge                              |
| `UNIQUE(AgentPayoutItem.loanId)`                          | one commission payout per loan                                         |
| `AuditEvent.actor` required                               | a user who has ever acted can never be hard-deleted                    |
| `LoanApplication.customer` RESTRICT                       | a borrower with loans cannot be deleted                                |
| `CoMaker.customer` RESTRICT                               | same                                                                   |

## Delete rules — read before touching Customer

| Relation                                                                        | Rule        | If a Customer were deleted                |
| ------------------------------------------------------------------------------- | ----------- | ----------------------------------------- |
| `LoanApplication`                                                               | RESTRICT    | refused — correct                         |
| `CoMaker`                                                                       | RESTRICT    | refused — correct                         |
| `Contribution`                                                                  | **CASCADE** | silently deletes coop capital records     |
| `SavingsTransaction`                                                            | **CASCADE** | silently deletes savings movements        |
| `FundTransaction` / `FundWithdrawal`                                            | SetNull     | money kept, attribution lost              |
| `KycSubmission`, `CreditScore`, `SurveyResponse`, `AmlScreening`, `DorsiRecord` | CASCADE     | acceptable for a record that never traded |

**Closed 11 Aug 2026** (migration `20260811160000_coop_money_restrict`). Both
were CASCADE. A member who had saved for years and never borrowed was therefore
deletable — `LoanApplication` and `CoMaker` would have refused, but a member with
no loan has neither — and deleting them took every contribution and savings
movement with them while the cash stayed in the cooperative's bank account.

The application layer had already stopped deleting customers (archiving replaced
it in `3a9d0fa`); this closes the gap between what the service promises and what
the database permits, so a code path nobody has written yet fails loudly instead
of destroying money. Verified: a member with a ₱25,000 deposit now refuses
deletion with P2003 and the savings row survives.

## Lifecycle and privacy columns

| Column                                                   | Meaning                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Customer.erasedAt`                                      | PII redacted under a Data Privacy Act request; financial rows retained                     |
| `Customer.archivedAt` / `archiveReason` / `archivedById` | filed away: hidden from pickers and the default list, ineligible for new loans, reversible |
| `User.active`                                            | login disabled; checked at login **and** refresh                                           |
| `User.sessionsRevokedAt`                                 | cutoff that kills every token issued at or before it                                       |
| `LoanPayment.idempotencyKey`                             | opt-in replay key                                                                          |

## Migrations

Hand-written, applied with
`pnpm --filter @loan/db exec dotenv -e ../../.env -- prisma migrate deploy`.
Rules and the tenant fan-out requirement: `MIGRATIONS.md`.

A bare `npx prisma validate` at the repo root fails with a **Prisma 7** CLI error
(`datasource url no longer supported in schema files`). The repo pins Prisma
**6.19.3** and drives migrations through the `libs/db` scripts — a CLI-version
mismatch, not a schema defect. Pin the CLI invocation in CI so this cannot
surface as a confusing red build.

## Indexing

Present on the hot paths inspected: `entryDate`, `periodId`,
`(source, sourceRefId)`, `(sourceRefType, sourceRefId)`,
`(actorId, createdAt desc)`, `erasedAt`, `archivedAt`, `phone`,
`(governmentIdType, governmentIdNumber)`, `(loanId, paidOn desc)`,
`refreshToken.userId`.

No query-plan evidence yet. Capture `EXPLAIN` for the ten slowest endpoints at
realistic row counts before adding indexes in bulk (roadmap 4.2). §59 is right
that plans should precede indexes.
