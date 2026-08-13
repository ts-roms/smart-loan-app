# Migrations

Rules and history for schema changes. Required by §85; the rules themselves come
from §43, §45 and §74.

---

## How to run them

```bash
pnpm --filter @loan/db exec dotenv -e ../../.env -- prisma migrate deploy
```

Not a bare `npx prisma migrate deploy` — the connection URL comes from the root
`.env` via `dotenv`. A bare `npx prisma validate` at the repo root also fails
with a **Prisma 7** CLI error (`datasource url no longer supported in schema
files`); this repo pins Prisma **6.19.3**. Pin the CLI in CI.

`prisma generate` on Windows commonly reports `EPERM` renaming
`query_engine-windows.dll.node` while a dev server holds it. **The TypeScript
types still land** — verify with a typecheck rather than assuming the generate
failed.

### Do not run `migrate dev` against a database you care about

`prisma/migrations` and `schema.prisma` have **drifted**, and have for some
time. `prisma migrate diff` against a clean shadow database reports:

- `AuditEvent(impersonatedById)` and `Customer(erasedAt)` — declared in
  `schema.prisma`, created by no migration.
- `journal_source_ref_unique` — the posting-idempotency index, whose name in
  the database does not match the name Prisma derives
  (`JournalEntry_source_sourceRefType_sourceRefId_key`).

`prisma migrate status` reports **"up to date"** and is not wrong: every
migration has been applied. Drift is a different question, and status does not
ask it.

The consequence is operational, not cosmetic. `migrate dev` reconciles the
database to the schema, and on finding drift it offers to **reset** — which
drops the data. Use `migrate deploy`, which only applies pending migrations and
never resets. Exercise `migrate dev` on a throwaway database if you need it.

Fixing the drift means renaming the journal idempotency index, which is the
constraint behind §13 double-post prevention. That needs its own review and
a migration of its own; it is deliberately not bundled with unrelated work.

## Rules — §74

Every schema change must:

1. Have a Prisma migration in `libs/db/prisma/migrations/`. Hand-written SQL,
   not `migrate dev` autogeneration, so the intent is reviewable.
2. **Preserve existing data.** Additive by default: new columns nullable, or with
   a default.
3. **Handle every tenant schema.** See fan-out below.
4. Include a data migration where one is required.
5. State a rollback consideration in the SQL comment.
6. Include a reconciliation check where the change touches financial data.
7. Be tested — at minimum `migrate deploy` against a database with existing rows.

**Never** `DROP DATABASE`. **Never** casually `DROP TABLE`. Never recreate
production data.

## Tenant fan-out — §45

This is a **schema-per-tenant** deployment. A migration must be applied to the
`public` schema _and_ every `tenant_<slug>` schema. The machinery is
`libs/db/src/lib/multi-tenant-migrate.ts`, tested by
`multi-tenant-migrate.test.ts`, and driven by `libs/db/scripts/migrate-tenants.mjs`.

Before release, verify the migration against:

- the public schema
- at least one existing tenant schema
- a freshly provisioned tenant (which runs every migration from zero)

Do not assume only one schema exists.

## Preconditions for specific migrations

Some migrations cannot be applied blindly to a database with history. Record
them here as they are added.

| Migration                                  | Precondition                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260811120000_journal_source_ref_unique` | **Run `libs/db/scripts/detect-duplicate-journal-entries.mjs` first.** The unique index cannot be created while duplicate `(source, sourceRefType, sourceRefId)` groups exist. The script is read-only and reports the groups; the remedy for a duplicate is a **reversing entry**, not a delete, because the redundant entry has real ledger lines behind it. Verified clean on the dev database (27 entries, 0 duplicate groups) before the index was added. |

## Data-migration safety — §46

Before modifying production financial data:

```
Backup → Dry run → Validation → Migration → Reconciliation → Audit
```

Never perform a destructive data migration without explicit approval. After any
migration that touches financial rows, confirm the trial balance still ties.

## History — recent

Full list: `libs/db/prisma/migrations/`. **72 migrations** as of 12 Aug 2026.

| Migration                                   | Change                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260812090000_scoring_catalog_versioning` | `ScoringCatalogVersion`, `CreditScore.catalogVersion`, `SurveyResponse.catalogVersion`                                                         | Additive. The BASELINE version is **not** written by this migration — it is minted at boot by `ScoringCatalogRepository.ensureBaseline()`, because the snapshot has to be the shape `@loan/credit-scoring` consumes, its `DEFAULT_CATALOG` fallback included. Reproducing that mapping in SQL would duplicate it, and the duplicate is what goes stale. |
| `20260811180000_decision_rule_versioning`   | `DecisionRule.version/effectiveFrom/retiredAt`, new `DecisionRuleVersion`, `LoanApplication.decisionRule*`, `PreAssessment.matchedRuleVersion` | Additive and backfilling. Every existing rule gets a version 1 whose `effectiveFrom` is the rule's own `createdAt` — **not** `now()`: dating them to migration time would be a worse record than none, because it would look precise. Loans decided earlier keep null decision columns, which is honest; the information was never captured.            |
| `20260811160000_coop_money_restrict`        | `Contribution` / `SavingsTransaction` FK CASCADE → RESTRICT                                                                                    | Prevents a member deletion from taking their money records with it.                                                                                                                                                                                                                                                                                     |
| `20260811130000_payment_idempotency_key`    | `LoanPayment.idempotencyKey` + UNIQUE                                                                                                          | Additive and nullable — callers that send no key behave exactly as before, and NULLs are distinct in a Postgres unique index so they never collide. No data migration.                                                                                                                                                                                  |
| `20260811120000_journal_source_ref_unique`  | `UNIQUE(JournalEntry.source, sourceRefType, sourceRefId)`                                                                                      | See precondition above. NULL `sourceRefId` (manual entries) unaffected.                                                                                                                                                                                                                                                                                 |
| `20260808150000_customer_archive`           | `Customer.archivedAt`, `archiveReason`, `archivedById` + index                                                                                 | Soft delete replacing hard delete. Additive; existing rows have NULL and behave as before.                                                                                                                                                                                                                                                              |
| `20260807180000_notification_ref_number`    | notification reference consistency                                                                                                             |                                                                                                                                                                                                                                                                                                                                                         |
| `20260807160000_agent_payout`               | agent payout run                                                                                                                               |                                                                                                                                                                                                                                                                                                                                                         |
| `20260807140000_agent_commission`           | agent commissions                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                         |

## Rollback

Prisma does not generate down-migrations, and this repository does not maintain
them. Rollback strategy is therefore:

- **Additive migrations** (the default here): roll back the _application_, leave
  the column. An unused nullable column is harmless.
- **Constraint additions**: drop the index/constraint by name. Recorded in each
  migration's comment where relevant.
- **Anything destructive**: restore from backup. See
  `docs/modernization/disaster-recovery.md`.

This is why the additive-by-default rule matters more here than in a system with
reversible migrations.
