# Compliance

Philippine lending and cooperative context. **Nothing here is legal advice**, and
§70 is right to insist on that: the rules below are what the _system_ implements
and where it is configurable, not an assertion of what the law requires. Every
threshold is flagged for professional validation.

---

## Data Privacy Act — §71

| Capability         | Implementation                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data export (DSAR) | `POST /compliance/customers/:id/export` — one JSON file: profile, KYC, loans, schedules, payments, audit events, contributions, savings, screenings, survey responses, credit scores, notifications |
| Soft erasure       | `POST /compliance/customers/:id/erase` — redacts identifying fields, returns the exact `fieldsCleared` and `retainedTables`                                                                         |
| Retention policy   | `GET`/`PUT /compliance/retention-policy` — audit, notification and job-run windows                                                                                                                  |
| Manual purge       | `POST /compliance/retention-purge` — reports rows deleted and cutoffs                                                                                                                               |
| UI                 | `/compliance/privacy`, gated on `admin.compliance`                                                                                                                                                  |
| Audit              | every export and erasure writes an audit row with the operator's reason                                                                                                                             |

**Financial records are never deleted for a privacy request.** Erasure redacts
PII and leaves loans, payments, journal entries and the ledger intact; the
erasure receipt names both lists so the operator can read them back to the data
subject. `Customer.erasedAt` drives an "Erased" badge and banner so a record
full of `[ERASED]` placeholders reads as deliberate rather than as data loss,
and the API refuses edits and new loans on an erased customer at both the
service and repository layers.

### AMLA retention floor

`AMLA_AUDIT_FLOOR_DAYS = 1825` (five years). When the configured audit-retention
window drops below it, the API returns `auditBelowAmlaFloor: true` and the UI
shows an unmissable warning rather than silently purging.

**Flagged for validation:** whether five years is the correct floor for every
record class this system holds, and whether the notification and job-run windows
have their own statutory minima.

## AMLA / KYC

| Capability          | Implementation                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Watchlist screening | `libs/screening`, `AmlScreening` + `AmlWatchlistEntry`; screens on customer create, best-effort |
| Hard block          | an unresolved `MATCH` blocks loan application                                                   |
| Override            | admin-only, posts an `OVERRIDDEN` row that supersedes the match                                 |
| KYC documents       | per-product required-document sets; completeness gates **approval**, not submission             |
| Declarations        | per-product questionnaires, snapshotted as asked at application time                            |
| Face match          | `selfieMatchScore` / `selfieMatchPassed` at 0.55                                                |

## DORSI

`features/dorsi` — Directors, Officers, Stockholders and Related Interests.
Aggregate and individual utilisation percentages against equity, with board
approval recorded.

**Fail-closed by design:** when total equity is zero (unconfigured), utilisation
reports `configured: false` and `checkLoan` returns `BOARD_REQUIRED` rather than
treating an unconfigured cap as unlimited headroom. An unconfigured control must
never read as "all clear".

**Flagged for validation:** the caps themselves are configuration, and the
correct percentages are a regulatory question.

## Annual / renewable documents

`AnnualDocument` with expiry tracking; the dashboard buckets by actual
`expiresAt` rather than a cached status, so a document that expired overnight
appears expired without waiting for a job.

## Not implemented

| Requirement                                 | Status                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credit Information Corporation submission   | **MISSING** — no CIC export exists                                                             |
| BSP reporting formats                       | **MISSING** — general reports exist; no BSP-shaped return                                      |
| SEC reporting                               | **MISSING**                                                                                    |
| Consumer-protection disclosures             | **NEEDS VALIDATION** — see the effective-rate note below                                       |
| Chattel / real-estate mortgage registration | **PARTIAL** — `Vehicle`/`Property` capture the instruments; registration workflow not modelled |
| Insurance tracking                          | **PARTIAL** — fields exist on collateral; expiry alerting not confirmed                        |

### Effective interest rate — worth a compliance conversation

Flat (add-on) interest is charged on the original principal for the full term
while the balance declines. The golden corpus makes the consequence concrete: a
₱120,000 motorcycle loan at **24% flat** over 3 years produces **₱86,400** of
interest — 72% of principal — because the nominal rate and the effective rate
differ by roughly a factor of two.

This is normal, legal add-on lending. It becomes a compliance question if any
disclosure obligation requires an **effective** rate to be quoted and the
product configuration advertises the nominal one. The system computes both
inputs; whether it must display the effective figure is a question for counsel,
not for this document.
