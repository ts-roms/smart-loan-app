# Phase Verification — ten master-prompt phases, checked against code

Ten phases of the Enterprise LMS Modernization Master Prompt whose status had
**never been checked against the repository**. Each carries a §9 verdict and a
`file:line` that justifies it.

This document exists because `gap-matrix.md` and `roadmap.md` had been found
stale **six separate times** before this audit, always in the same direction: a
row says work is outstanding when it shipped weeks earlier. One stale row caused
a whole batch to be scheduled against a problem already fixed.

**This audit found three more** — OpenAPI, CSP, and the AI-assistant row (that
last one stale in the _opposite_ direction, understating what exists) — plus
eight stale entries in `roadmap.md`. Nine occurrences of the same failure is no
longer a series of accidents; the pattern is diagnosed at the bottom. The
corrections made are listed there too.

---

## Method — so the next person can repeat it

1. **Do not read the trackers first.** Read the code, then compare. Every claim
   below was established from source and only afterwards checked against
   `gap-matrix.md` / `roadmap.md`. Two of the corrections at the bottom exist
   precisely because the doc was read second.
2. **A verdict requires a citation.** `path:line`, not "the audit says". Where a
   claim is an _absence_, the citation is the exhaustive search that found
   nothing — and the search must be run against a pattern that could have
   succeeded. Several near-misses here came from greps whose pattern could only
   ever have matched one spelling.
3. **Watch for false positives in absence searches.** `grep redis` matches
   `rediscover` and `redistributes`; `LOAN_DISBURSED` is a _notification event_,
   `LOAN_DISBURSEMENT` is a _journal source_, and neither is an audit action.
   Distinguish the namespace before concluding.
4. **Separate "the mechanism exists" from "the mechanism is wired".** Several
   findings here are endpoints with no caller, templates with no dispatch, and
   fields that exist but are never populated. A schema column is not a control.
5. **Trace negative requirements to a call site**, never to a comment. "The AI
   cannot approve loans" is only true if you have enumerated what the AI can
   invoke.
6. Verdicts use the brief's §9 vocabulary only: EXISTS — GOOD / EXISTS — NEEDS
   HARDENING / EXISTS — NEEDS REFACTORING / PARTIALLY IMPLEMENTED / MISSING /
   DANGEROUS / HIGH RISK / TECHNICAL DEBT.

**Base:** `4a79bbc` on `feat/feature-update`. Read-only audit — no application
code, schema, migration or test was changed.

---

## Verdicts

| §      | Phase                | Verdict                      | Anchor citation                                                      |
| ------ | -------------------- | ---------------------------- | -------------------------------------------------------------------- |
| §35    | 13 — IFRS-9 / ECL    | **PARTIALLY IMPLEMENTED**    | `libs/db/src/repositories/ecl.repository.ts:60-64`, `:162-165`       |
| §47    | 17 — Customer Portal | **EXISTS — NEEDS HARDENING** | `apps/api/src/features/portal/portal.routes.ts:90-124`               |
| §48    | 18 — Notifications   | **PARTIALLY IMPLEMENTED**    | `libs/notifications/src/index.ts:60-70`                              |
| §50/51 | 20 — AI              | **EXISTS — NEEDS HARDENING** | `apps/api/src/lib/llm.ts:36-41` (advisory-only holds)                |
| §52    | 21 — Reporting       | **PARTIALLY IMPLEMENTED**    | `libs/db/src/repositories/accounting.repository.ts:412-497`          |
| §56    | 25 — Audit Trail     | **EXISTS — NEEDS HARDENING** | `libs/db/prisma/schema.prisma:1778-1810`                             |
| §57    | 26 — Observability   | **EXISTS — NEEDS HARDENING** | `apps/api/src/app.ts:56-79`                                          |
| §68    | 32 — DevOps          | **EXISTS — GOOD**            | `deploy/docker/docker-compose.yml:30`, `libs/jobs/src/index.ts:9-12` |
| §70    | 34 — PH Compliance   | **PARTIALLY IMPLEMENTED**    | `libs/pdf/src/agreement.ts:148-166`                                  |
| §71    | 35 — Data Privacy    | **EXISTS — NEEDS HARDENING** | `apps/api/src/features/compliance/compliance.service.ts:323-371`     |

Nothing here is rated DANGEROUS at the system level. One sub-item is —
**ECL re-run double-posting** (§35) — and it is called out in its own section
rather than being averaged away into a phase verdict.

---

## §35 Phase 13 — IFRS-9 / ECL — PARTIALLY IMPLEMENTED

The compute-and-post path is real. The §35 requirement that assumptions be
**configurable and versioned** is not met, and one re-run behaviour is unsafe.

**What exists**

- Stage 1/2/3 from a DPD ladder — `libs/db/src/repositories/ecl.repository.ts:60-64`
  (`>=90` → Stage 3, `>=30` → Stage 2, else Stage 1); DPD derived from the oldest
  unpaid installment at `:111-117`.
- PD/LGD are **per-product DB columns**, not literals —
  `libs/db/prisma/schema.prisma:913-917` (`eclPd12m` 0.05, `eclPdLifetime` 0.20,
  `eclLgd` 0.45), selected by stage at `ecl.repository.ts:121-125`.
- EAD computed as remaining principal — `ecl.repository.ts:128-133`;
  `ECL = EAD × PD × LGD` at `:134`.
- Provisions **are posted to the GL** — entry builder
  `libs/accounting/src/posting.ts:656-706` (Dr Impairment Loss / Cr Allowance),
  posted via `postIfAbsent` at `ecl.repository.ts:192-207`, journal id written
  back at `:208-211`.
- Per-loan results persisted — `libs/db/prisma/schema.prisma:1189-1193`
  (`eclStage`, `eclProvision`, `eclComputedAt`).
- **Movement analysis exists** — `apps/api/src/features/reports/reports.service.ts:269-300`,
  dispatched at `:90-94`, surfaced as a report card.

**What is absent**

| Requirement                 | Finding                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioned assumptions       | **MISSING.** `model EclRun` stores outputs only — `libs/db/prisma/schema.prisma:2590-2615`. No PD/LGD/threshold snapshot, no `EclAssumptionSet` model exists.                                                                              |
| Configurable assumptions    | **PARTIAL.** PD/LGD are columns but omitted from the product write schema — `apps/api/src/features/loan-products/schemas.ts:52-95` (read-only at `:164-167`). Staging thresholds are compile-time literals at `ecl.repository.ts:61-63`.   |
| By PRODUCT                  | **MISSING** — run result carries `byStage` only, `ecl.repository.ts:36-56`.                                                                                                                                                                |
| By BRANCH                   | **MISSING** — no branch entity exists in the domain at all.                                                                                                                                                                                |
| By VINTAGE                  | **MISSING for ECL.** A vintage cohort report exists (`libs/db/src/repositories/accounting.repository.ts:530-567`) but buckets default rate, never `eclStage`/`eclProvision`.                                                               |
| SICR staging / Stage-3 cure | **MISSING, and the header claims otherwise.** `ecl.repository.ts:16-19` describes a one-way Stage-3 door with a 6-month cure; `stageFromDpd` at `:119` never reads the prior stage. A loan paying one installment drops Stage 3 → Stage 1. |

**DANGEROUS sub-item — re-run double-posts the provision movement.**
`previous` is looked up with `periodEnd: { lt: input.periodEnd }`
(`ecl.repository.ts:162-165`), so a second run for the _same_ period recomputes
the _same_ delta; because each run mints a new `EclRun.id` (`:171`) and
`postIfAbsent` keys on `sourceRefId = run.id`
(`libs/accounting/src/posting.ts:672-673`), the idempotency guard does not fire
and the movement posts twice. The code admits it at `ecl.repository.ts:199-202`
("callers managing re-runs should delete the prior run first"), nothing in the
API enforces it (`POST /ecl/runs` accepts an empty body and defaults `periodEnd`
to today — `apps/api/src/features/ecl/ecl.service.ts:26-32`), and **the UI tells
the operator the opposite**: "This is idempotent — safe to re-run" at
`apps/web/src/features/ecl/pages/EclRunsPage.tsx:47`. A misleading confirmation
dialog over a double-posting path is the worst combination available.
Severity: **P1** — real money into the GL, but operator-triggered and
detectable by the standing reconciliation job.

Also: the three write steps (`:149`, `:171`, `:204`) are not wrapped in a
transaction, and there is **no ECL test file anywhere** — staging, PD selection,
EAD and delta logic are untested.

**The per-loan ECL columns are write-only.** `eclStage`, `eclProvision` and
`eclComputedAt` are written at `ecl.repository.ts:152-154` and declared at
`libs/db/prisma/schema.prisma:1189-1193`, but **nothing reads them back** — the
only other occurrences in the repository are two schema comments (`:2575`,
`:2599`). No API response schema selects them and no `.tsx` references them, so
the stage and provision stamped on each loan never reach a detail page, a queue,
an export or a report. Every consumer-visible ECL figure comes from the aggregate
`EclRun` row (`apps/api/src/features/ecl/schemas.ts:38-57`) or from the transient
in-memory `perLoan` array (`ecl.repository.ts:44-51`), which is shown once and
discarded. Loan-level provisioning is therefore **not auditable after the fact**:
you can ask what the portfolio total was at the September run, not what loan X's
stage and provision were. This compounds the versioning gap — neither the
assumptions nor the per-loan outputs of a historical run are recoverable.

**Remaining work:** assumption-set model + FK snapshot (2–3 d) · re-run guard and
transaction (1 d) · PD/LGD writable (0.5 d) · product/vintage breakdowns (2–3 d) ·
tests (1–2 d). Branch breakdown is blocked on there being no branch entity.

---

## §47 Phase 17 — Customer Portal — EXISTS — NEEDS HARDENING

Substantial, correctly ownership-scoped, and hosted inside `apps/web` behind a
role branch — `apps/web/src/App.tsx:352` — not a separate app.

**What exists.** Every route is CUSTOMER-scoped from the JWT; no path accepts a
customerId — `apps/api/src/features/portal/portal.routes.ts:90-124`, guard
`portal.service.ts:100`, ownership check `:206`.

| Feature                    | Endpoint                                                      |
| -------------------------- | ------------------------------------------------------------- |
| Loans + balance            | `portal.routes.ts:161`, `:175`                                |
| Schedule / statement / CSV | `portal.routes.ts:356`, `:378`; PDF `documents.routes.ts:119` |
| Payment history            | `portal.routes.ts:356`                                        |
| Make a payment             | `portal.routes.ts:308`, `:325`                                |
| Apply / pre-assess         | `portal.routes.ts:206`, `:257`                                |
| KYC upload                 | `portal.routes.ts:290`, `:276`                                |
| Profile update             | `portal.routes.ts:143` (contact + address only)               |
| e-signature                | `portal.routes.ts:190`                                        |
| Message an officer         | `apps/api/src/features/loans/loans.routes.ts:1585`, `:1606`   |
| Coop savings/contributions | `portal.routes.ts:381`, `:397`, `:342`                        |

**Mobile-first: responsive, but not mobile-first.** The chrome was built for
phones — off-canvas drawer `apps/web/src/components/PortalShell.tsx:101-118`,
mobile header `:253-264`, viewport with notch handling `apps/web/index.html:5`.
The pages were not: only `md:` breakpoints are ever used (no `sm:` tier), padding
is fixed at `PortalShell.tsx:269`, and **five of six data tables have no
horizontal-scroll wrapper** (only `PortalLedger.tsx:364` does) — on a 360px
phone they overflow.

**Absent:** borrower notification inbox entirely — `NotificationBell` is mounted
only in the staff shell (`apps/web/src/components/DashboardShell.tsx:754`) and
`/notifications` sits inside the staff `<Routes>` block after the CUSTOMER branch
returns (`App.tsx:352-376`). Also no portal top-up/restructure request, and no
general dispute/support channel outside the per-loan thread.

**One defect worth its own line.** `apps/api/src/features/auth/auth.service.ts:533-536`
counts unseen notifications with `where = { createdAt: { gt: cursor } }` — **no
user or customer scoping at all**. Any authenticated caller, borrower included,
receives a count of every notification in the tenant. It leaks a count, not
content, so severity is **P2**, but it is a real scoping bug rather than a
missing feature.

**Remaining work:** notification inbox + scoped endpoint (~1.5 d, includes the
bug above) · mobile hardening (~2–3 d) · dispute channel (~3–5 d).

---

## §48 Phase 18 — Notifications — PARTIALLY IMPLEMENTED

The catalog, templates, persistence and scheduled reminders are real. The
providers are not, a third of the catalog never fires, and there is no queue.

**Channels — no real adapter exists for any of them.** Type is
`EMAIL | SMS | IN_APP` — `libs/notifications/src/index.ts:13`; **there is no PUSH
channel** anywhere. The only concrete provider is `MockNotificationProvider`,
whose `send()` is a `console.log` — `libs/notifications/src/index.ts:60-70`. The
factory falls through to it for every named provider —
`apps/api/src/providers.ts:44-52` (`SENDGRID`/`TWILIO`/`SES` → "not yet
implemented — falling back to MOCK"). Per-tenant provider wiring is
credential-plumbing returning a tagged mock —
`apps/api/src/features/system/notification-providers.ts:143-166`. IN_APP is the
one channel with real persistence — `libs/db/src/repositories/notification.repository.ts:71-84`
— but as above, no borrower can read it.

**The eleven events.** Catalog of 21 at `libs/notifications/src/index.ts:15-36`,
templates at `:119-229`. Roughly **four of the eleven** the brief lists actually
fire. Dispatching: `LOAN_DISBURSED` (`apps/api/src/features/loans/loans.service.ts:729`),
`PAYMENT_DUE_SOON` (`apps/api/src/jobs.ts:188`, `:206`), `PAYMENT_OVERDUE`
(`jobs.ts:253`, `:271`), plus approver fan-out, demand letters, statements,
password reset, lease and annual-doc reminders.

Templated but **never dispatched** — verified by exhaustive grep for each literal:

- `LOAN_APPROVED` (`libs/notifications/src/index.ts:121`) and `LOAN_REJECTED`
  (`:125`) — the decide path `loans.service.ts:622-627` sends nothing.
- `PAYMENT_RECEIVED` (`:133`) — neither `libs/db/src/repositories/loan.repository.ts:1357`
  nor the webhook settle path `payment-intent.repository.ts:176` dispatches.
  **A borrower who pays is never told the payment landed.**
- `PROMISE_TO_PAY` (`:145`), `WELCOME` (`:164`).

Not in the enum at all: application-received, loan-fully-paid, restructure,
KYC-status-change, document-request.

**The architectural requirement — background jobs, not blocking financial
transactions.** Result: **not blocking, but not via a queue either.**

- **No queue and no outbox exist.** `libs/jobs/src/index.ts:9-12` is a cron
  scheduler and says so ("Why not BullMQ? … We don't need Redis-level fan-out
  yet"); runtime is one `setInterval` at `libs/db/src/tenant-scheduler.ts:98`.
  There is no `enqueue` and no outbox table.
- **Nothing is awaited inside a DB transaction.** Disbursement commits first —
  `loans.service.ts:719-721` — and only then notifies inside a `try/catch` whose
  comment reads "Non-fatal — the disburse already committed" (`:746-747`).
  Payment recording contains no notification code at all.
- **But the disbursement notification is still `await`ed in the HTTP request
  path** — `loans.service.ts:728`. Free against a mock; the moment a real
  SendGrid/Twilio client lands behind `providers.ts:44`, a hung provider socket
  becomes a hung disbursement response with money already moved. Same shape at
  `demand-letters.service.ts:191`, `ledger.service.ts:107`/`:118`,
  `rbac.service.ts:226`, `delegations.service.ts:354`.
- Failure handling is terminal: catch, mark `FAILED`, return —
  `libs/db/src/repositories/notification.repository.ts:101-109`. No retry, no
  backoff, no dead-letter, no redelivery job.

Classification for the delivery architecture specifically: **TECHNICAL DEBT** —
it is correct today only because the providers are mocks.

**Remaining work:** outbox + drain job + retry/DLQ, migrating the six inline call
sites (~3–5 d) · real adapters (~1 d each; push needs a device-token model) ·
wire the six dead events (~1–2 d) · per-customer preferences/opt-out (~2–3 d —
for SMS to Philippine borrowers this is a regulatory exposure, not a nicety).

---

## §50/§51 Phase 20 — AI — EXISTS — NEEDS HARDENING

**The advisory-only guarantee holds.** This was the most important thing to
verify and it verifies cleanly.

**The AI has no tools, no function-calling and no action registry.** The entire
provider contract is text-in/text-out — `apps/api/src/lib/llm.ts:36-41`; input is
`{ system, user, maxTokens }` (`:17-24`), output is
`{ text, tokenCount, model, isMock }` (`:26-34`), and the Ollama request body
carries **no `tools` key** (`:124-145`).

| Can the AI independently… | Verdict    | Proof                                                                                                                                                                        |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) approve/reject loans  | **CANNOT** | The only write in the feature is `audit.record` — `apps/api/src/features/assistant/assistant.routes.ts:144`, `:195`, `:268`. Reads only: `loans.findById` at `:133`, `:184`. |
| (b) change balances       | **CANNOT** | No schedule/application update in the feature; the only other Prisma call is a `findUnique` at `:236-253`.                                                                   |
| (c) post accounting       | **CANNOT** | Imports are exactly `AuditLogRepository, LoanRepository` — `assistant.routes.ts:25`.                                                                                         |
| (d) disburse              | **CANNOT** | Handlers registered are only `/ping`, `/explain-decision`, `/draft-demand-letter`, `/summarize-account` — `:87`, `:111`, `:162`, `:214`.                                     |
| (e) reverse payments      | **CANNOT** | No payment repository imported.                                                                                                                                              |
| (f) write off             | **CANNOT** | No write-off path imported.                                                                                                                                                  |

No response is ever parsed into a mutation — all three handlers return the raw
string and stop (`assistant.routes.ts:157`, `:209`, `:281`); there is no
`JSON.parse` or verdict extraction in the file. Clients cannot even send prompt
text: inputs are UUIDs and a fixed enum — `apps/api/src/features/assistant/schemas.ts:12-14`,
with the reasoning at `:5-8`. Loan decisioning is a separate deterministic
rules engine (`apps/api/src/lib/pre-decision.ts`), and `createLLMProvider` is
referenced in exactly one non-lib file.

**Local-first is true, and remote is off by default** — `apps/api/src/config.ts:180`
(`OLLAMA_URL` defaults to `""`), `llm.ts:173-174` (no URL → `MockProvider`, never
makes a network call). Only two providers exist; no OpenAI/Anthropic/Bedrock SDK
is present anywhere in the repo. Caveat: `OLLAMA_URL` is unvalidated, so an
operator can point it at a remote host over plain HTTP. Local-first is a
_default_, not an _enforced invariant_.

**§51 auditability — 4 of 7 fields stored.** There is no dedicated AI audit
model; interactions land in the generic `AuditEvent`.

| §51 field        | Stored | Evidence                                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------------------ |
| model            | ✅     | `assistant.routes.ts:151` (also `:202`, `:275`)                                            |
| prompt version   | ❌     | No `promptVersion` anywhere; templates are inline consts at `:295`, `:303`, `:313`, `:327` |
| input reference  | ✅     | `:147-148` (`targetType`/`targetId`) — the rendered prompt itself is not stored            |
| output           | ❌     | Deliberate — `:16-18`; payload carries only `tokenCount` (`:152`)                          |
| timestamp        | ✅     | `libs/db/prisma/schema.prisma:1789`                                                        |
| user             | ✅     | `:146` plus impersonator attribution via `audit-log.repository.ts:91-92`                   |
| decision context | ❌     | Payload is `{ provider, model, tokenCount, isMock }` — `:149-154`                          |

The gap matrix's "§51 AI audit trail not stored" was therefore **too pessimistic**
— four fields are stored. Corrected below.

**Remaining work:** prompt versioning (~2–4 h) · `AiInteraction` model for
input/output with its own retention class (~1–2 d) · decision context (~2–3 h) ·
`OLLAMA_URL` egress guard (~2–3 h) · **a regression test — there is no
`assistant.routes.test.ts` or `llm.test.ts`, so the advisory-only property is
guaranteed only by code reading** (~4–6 h). That last one is the item I would do
first: the property is correct today and nothing stops a future tool array.

---

## §52 Phase 21 — Reporting / Analytics — PARTIALLY IMPLEMENTED

Three of the four dashboard families exist to some degree; one is absent.

**PORTFOLIO — EXISTS — GOOD.** PAR 30/60/90, NPL, outstanding, originations —
`libs/db/src/repositories/accounting.repository.ts:412-497` (PAR banding
`:458-464`, NPL `:493`); route `apps/api/src/features/accounting/accounting.routes.ts:456`.
Aging `accounting.repository.ts:758` + `libs/accounting/src/reports.ts:347`;
vintage cohorts `accounting.repository.ts:530-567`. Frontend
`apps/web/src/features/accounting/pages/Analytics.tsx`.
_Caveat (TECHNICAL DEBT):_ the sparklines beside the hero KPIs are **synthesized,
not measured** — `synthCumulative` fabricates an S-curve
(`apps/web/src/features/dashboard/pages/Dashboard.tsx:1091-1103`) and
`approximateNplTrend` emits a sine wobble around the current value (`:1105-1114`).
Honestly labelled at `:1083-1089`, but an operator sees a trend line that means
nothing.

**COLLECTIONS — PARTIALLY IMPLEMENTED.** Roll-rate exists —
`libs/accounting/src/roll-rate.ts:266`, route
`apps/api/src/features/reports/reports.routes.ts:94`. Collections aging export
`reports.service.ts:155-181`. Collector _workload_
`libs/db/src/repositories/collections.repository.ts:445-465`.
**Absent:** recovery rate (no aggregate exists — `libs/accounting/src/recovery.test.ts`
is a posting-bug regression test, not a module), promise-to-pay performance
(PTPs are stored at `libs/db/prisma/schema.prisma:1666` but nothing aggregates
honored-vs-broken), collector performance beyond headcount, and any collections
dashboard **page**.

**PRODUCT — PARTIALLY IMPLEMENTED.** Profitability engine
`libs/accounting/src/profitability.ts:213`, route `reports.routes.ts:151`,
rendered as one card at `apps/web/src/features/reports/pages/ProductProfitabilityCard.tsx`.
Product mix is client-side counting only —
`apps/web/src/features/dashboard/pages/Dashboard.tsx:1138-1162`.

**CREDIT — MISSING.** No approval-rate, score-distribution or decision-outcome
aggregate exists. `apps/api/src/features/scoring/scoring.routes.ts` exposes only
survey/score/tier/catalog CRUD — nothing statistical. No `/credit` route in
`apps/web/src/App.tsx:389-466`. All source data (`CreditScore`,
`LoanApplication.status`, `tierAtApply`, `LoanApproval`) already exists.

**Remaining work:** credit dashboard (3–5 d) · recovery rate (1–2 d) · PTP
performance (1 d) · collector performance (2 d) · collections page (1–2 d) ·
real timeseries to replace the synthesized sparklines (2–3 d — nothing stores
historical portfolio state today).

---

## §56 Phase 25 — Audit Trail — EXISTS — NEEDS HARDENING

The mechanism is sound and impersonation attribution is genuinely strong. **Five
of the thirteen required fields are absent, and the three largest money movements
are not audited at all.**

### The thirteen fields

Model at `libs/db/prisma/schema.prisma:1778-1810`.

| §56 field         | Present | Evidence                                                             |
| ----------------- | ------- | -------------------------------------------------------------------- |
| `user_id`         | ✅      | `actorId` — `schema.prisma:1783`                                     |
| `tenant_id`       | ⚠️      | **No column** — implicit in schema-per-tenant isolation; see note    |
| `action`          | ✅      | `schema.prisma:1781`                                                 |
| `entity_type`     | ✅      | `targetType` — `:1785`                                               |
| `entity_id`       | ✅      | `targetId` — `:1786`                                                 |
| `old_value`       | ❌      | No column — may appear inside `payload` Json (`:1788`) by convention |
| `new_value`       | ❌      | No column — same                                                     |
| `reason`          | ❌      | No column — same                                                     |
| `ip_address`      | ❌      | **Absent**                                                           |
| `user_agent`      | ❌      | **Absent**                                                           |
| `timestamp`       | ✅      | `createdAt` — `:1789`                                                |
| `request_id`      | ❌      | **Absent**                                                           |
| `impersonated_by` | ✅      | `impersonatedById` + `impersonatedByEmail` — `:1795-1796`            |

`tenant_id` is rated ⚠️ rather than ❌ deliberately: tenancy is schema-per-tenant
(`libs/db/src/multi-tenant-plugin.ts:88-152`), so the row's schema _is_ the tenant
discriminator. That is a defensible design, not an omission — but a cross-tenant
audit query has no column to filter on.

`old_value`/`new_value`/`reason` are rated ❌ because they are **conventions, not
schema**. Some call sites put a reason in `payload` (e.g.
`compliance.service.ts:377-389` records `fieldsCleared`); nothing enforces or
validates it, so it cannot be queried or relied upon.

**The gap matrix was right here** — its note to add `request_id`, `ip`,
`user_agent` is accurate and remains open. This is the one row this audit
_confirmed_ rather than corrected.

### The seventeen actions

The canonical seventeen-item list is not in the repository (see Limitations), so
this compares against the expected set. Distinct audit actions were enumerated by
grepping every `action:` literal, then discarding non-audit namespaces —
`libs/collections/src/priority.ts:471-526` are collection _recommendations_ and
`libs/decisioning/src/index.ts:119-243` are decision _outcomes_, neither of which
writes an `AuditEvent`.

**Covered:** loan decision/approval (`approvals.routes.ts:134`, `:216`),
write-off (`loans.routes.ts:1222`), restructure (`:1082`), renewal (`:1016`),
penalty waiver (`:1170`), journal reversal (`journal.service.ts:127`, `:170`),
role/permission changes (`rbac.service.ts:250`, `:290`, `:459`, `:579`, `:598`,
`:1041`, `:1117`), user create (`:768`), config change
(`system.routes.ts:161`, `:264`, `:402`), impersonation
(`platform.service.ts:810`, `:830`), privacy actions
(`compliance.service.ts:209`, `:378`), retention
(`retention.service.ts:137`, `:235`), customer archive/restore
(`customers.service.ts:195`), ECL run (`ecl.service.ts:41`), report generation,
demand letters, repossession, delegations, DORSI, leases, licensing, bank
statement import.

**Not audited — verified by exhaustive grep for each literal:**

| Expected action                   | Finding                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Disbursement**                  | **No audit action.** `LOAN_DISBURSED` is a notification event (`loans.service.ts:729`); `LOAN_DISBURSEMENT` is a journal source (`libs/accounting/src/posting.ts:22`). Neither writes an `AuditEvent`.                                                                   |
| **Payment recorded**              | **No audit action** — `loan.repository.ts:1357` records the payment and audits nothing.                                                                                                                                                                                  |
| **Payment reversal**              | **No audit action** — only the GL side is audited, via `JOURNAL_REVERSE`.                                                                                                                                                                                                |
| **Journal post**                  | **No audit action** — reversals are audited, original postings are not.                                                                                                                                                                                                  |
| **Period close**                  | **No audit action** (`PERIOD_CLOSED` at `accounting.repository.ts:214` is an error code, not an audit row).                                                                                                                                                              |
| **Login / logout / failed login** | **No audit action.** Adjacent security events are audited — `TOTP_ENABLED`/`DISABLED`/`RECOVERY_USED` (`auth.service.ts:614`, `:650`, `:229`), `REFRESH_TOKEN_REUSE_DETECTED` (`:303`), `SESSIONS_REVOKED` (`rbac.service.ts:978`) — but ordinary authentication is not. |
| **Customer PII update**           | **No audit action** — archive/restore and erase are audited; an ordinary PATCH of customer fields is not.                                                                                                                                                                |

**Severity: P1, and the honest nuance matters.** These actions are not
_untraceable_ — actor attribution lives on the domain rows themselves:
`LoanApplication.disbursedById` (`schema.prisma:1258`), `LoanPayment.recordedById`
(`:1407`), `JournalEntry.postedById` (`:1543`). So "who disbursed this loan" is
answerable. What does not exist is (i) a single audit trail that answers it
uniformly, and (ii) **any** record of _from which IP, which user-agent, or which
request_ a financial action was performed — because those three columns are
absent for every action, audited or not. An audit trail that cannot say which IP
or which request moved money is a real control gap, not a nice-to-have. It is not
P0 only because attribution survives elsewhere.

### Append-only in practice — a genuine tension

The repository exposes **no update path**: `AuditLogRepository` has exactly
`record()` (create) and `list()` — `libs/db/src/repositories/audit-log.repository.ts:72`,
`:103`. There is no `auditEvent.update` or `upsert` anywhere in the codebase.

**But there is one delete path, and it is deliberate.**
`apps/api/src/features/compliance/retention.service.ts:196-198` runs
`auditEvent.deleteMany({ where: { createdAt: { lt: auditCutoff } } })`.

This is §56 ("append-only") pulling directly against §71 ("retention policies"),
and the repository resolves it in §71's favour. What the policy can currently
reach:

- **Scope: every audit row past the cutoff, without discrimination.** The `where`
  clause filters on `createdAt` alone — there is no action-class carve-out. A
  `LOAN_APPROVAL_STEP`, a `LOAN_WRITE_OFF` and a `PLATFORM_TENANT_IMPERSONATE`
  row are deleted on exactly the same clock as a `REPORT_GENERATED` row. Deleting
  an approval or impersonation record is materially different from expiring a
  notification log, and the code does not distinguish them.
- **Floor is advisory, not enforced.** `AMLA_AUDIT_FLOOR_DAYS = 1825`
  (`retention.service.ts:71`) is surfaced as a boolean `auditBelowAmlaFloor`
  (`:99-102`, `:144-146`) and the file states plainly at `:110-113` that it
  "Doesn't enforce the AMLA floor". An administrator can set audit retention to
  30 days; the UI warns and the purge proceeds.
- `0` means opt-out (`:176-189`), so retention can be disabled entirely.
- The purge is itself audited (`:234-239`) — but that `RETENTION_PURGE` row is
  purgeable on the same clock, acknowledged at `:28-32`.
- **No DB-level enforcement.** No trigger, no revoked `DELETE`/`UPDATE` grant, no
  append-only constraint. Append-only is an application convention.

Recommendation (not applied — read-only audit): carve financial and
impersonation action classes out of the purge, and make the AMLA floor a
hard refusal for those classes rather than a flag.

### One further weakness

`record()` swallows its own failure — `audit-log.repository.ts:95-100` catches,
`console.error`s and returns `null`; every call site `await`s without checking
the return. A business action can therefore complete with **no audit row at
all**, and nothing surfaces it.

**Remaining work:** add `ipAddress`/`userAgent`/`requestId` + populate from the
request (~1–2 d incl. migration) · audit the five unaudited financial actions
(~1 d) · login/logout/failed-login (~0.5 d) · retention carve-out for financial
classes (~1 d) · fail-loud audit (~2–3 h).

---

## §57 Phase 26 — Observability — EXISTS — NEEDS HARDENING

| Requirement         | Verdict                                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured logging  | **EXISTS** — pino, JSON in prod, `pino-pretty` in dev — `apps/api/src/app.ts:56-79`                                                                                                                             |
| Request/correlation | **PARTIAL** — Fastify's built-in `req.id` only. No `genReqId`, no `x-request-id` ingest or propagation anywhere in `apps/api/src`, and no `requestId` on audit rows. Correlation stops at the process boundary. |
| Metrics             | **MISSING** — no `/metrics`, no Prometheus client, no counters/histograms anywhere                                                                                                                              |
| Health/ready/live   | **EXISTS — GOOD** — `/health/live` `apps/api/src/features/health/health.routes.ts:56`, `/health/ready` (DB ping, 503 on failure) `:75`, legacy `/health` alias `:110`                                           |
| Error tracking      | **EXISTS** — Sentry, opt-in via `SENTRY_DSN`, no-op when unset — `app.ts:35-43`; 4xx noise excluded `:129`; tenant slug tagged `:140`                                                                           |
| DB monitoring       | **PARTIAL** — Prisma log levels only, `libs/db/src/client.ts:9`. No slow-query threshold, no pool metrics                                                                                                       |
| Job monitoring      | **EXISTS** — `JobRun` records status/started/finished/result/error/manual — `libs/db/prisma/schema.prisma` (`model JobRun`), indexed by status. No alerting on failure                                          |

**The negative requirement — no sensitive financial data or PII in logs.**
Checked, not assumed. Result: **holds in production, does not hold in
development.**

- Production redacts — `app.ts:57-72`: `req.headers.authorization`,
  `req.headers.cookie`, `req.body.password`, `req.body.refreshToken`,
  `req.body.governmentIdNumber`, `*.password`, `*.token`, `*.secret`, censored to
  `[REDACTED]`.
- **The redact block is inside the `config.isProd` ternary** (`app.ts:56`). The
  dev branch is `pino-pretty` with **no redaction at all**.
- Compounding it, `libs/db/src/client.ts:9` enables Prisma `"query"` logging in
  non-production — so a developer's console carries full SQL, and the redact list
  that would have covered `governmentIdNumber` is not active on that path.
- No log statement was found interpolating payment amounts or customer records
  directly, and request/response **bodies are not logged** by default.

Severity **P2**: production, the case the requirement is really about, is
covered. But dev/staging logs are a plausible PII egress (shipped to a shared
aggregator, pasted into a ticket), and the asymmetry is not documented anywhere.

**Remaining work:** metrics endpoint (~1 d) · request-id ingest/propagate/log,
which also unblocks the §56 `requestId` column (~1 d, do them together) ·
apply redaction in all environments (~1 h) · slow-query threshold (~0.5 d) ·
job-failure alerting (~1 d).

---

## §68 Phase 32 — DevOps — EXISTS — GOOD

**Docker for dev and prod, plus PaaS and bare-metal.** Dev is deliberately
database-only — `docker-compose.dev.yml:31`, with `:2-5` explaining that web
(Vite) and api (tsx) run on the host. Prod on-prem is
`deploy/docker/docker-compose.yml:30`. Railway configs exist for api/web/platform/
marketing/marketing-next, and `deploy/bare-metal/` carries an installer, a
systemd unit and an nginx example.

**Services.** dev: `db` (`postgres:16-alpine`, `docker-compose.dev.yml:34-35`).
prod: `db` (`:33-34`), `api` (`:58`, built from `Dockerfile.api`), `web`
(`:110`, nginx serving the SPA and proxying `/api/v1`), one-shot `seed` behind a
profile (`:142-144`). Base image pinned — `ARG NODE_VERSION=20.18.0`,
`deploy/docker/Dockerfile.api:26`.

**The Redis caveat — Redis is absent entirely, which is exactly what the brief
asks for.** No `REDIS_URL` anywhere; no `redis`/`ioredis`/`bullmq` dependency in
any `package.json`. Every apparent grep hit is a substring false positive
(`rediscover`, `redistributes`). The decision is recorded in code, not only in
docs — `libs/jobs/src/index.ts:9-12` — and the scheduler is genuinely in-process:
one `setInterval` at `libs/db/src/tenant-scheduler.ts:98`, started at
`apps/api/src/routes/index.ts:145`. **Nothing can fail to boot without Redis
because nothing reads it.**

Sub-caveat carried forward honestly: the single-writer assumption is real and
currently held by `numReplicas: 1` in `deploy/railway/railway.api.json`. The
advisory lock proposed in `financial-engine-audit.md:184` is not implemented —
`tenant-scheduler.ts` goes straight to `tickDueJobs` at `:158`.

**Other checks.** CI exists — `.github/workflows/ci.yml:17`, five parallel jobs
(validate/typecheck/build/lint/test). Migrations run on deploy via the start
script, `apps/api/package.json:11`, with the rationale and the incident that
caused it at `Dockerfile.api:125-133`. Healthchecks at every layer
(`docker-compose.dev.yml:45-49`, `deploy/docker/docker-compose.yml:43-51`,
`Dockerfile.api:122-123`). Volumes for DB and uploads (`docker-compose.yml:161-163`).
Secrets fail fast rather than defaulting — `${POSTGRES_PASSWORD:?...}` at
`docker-compose.yml:39`, same guard on `WEB_ORIGIN` `:77` and `JWT_SECRET` `:80`.
Non-root `USER node` at `Dockerfile.api:101`; prod DB and api publish no host
port. Backup/restore **and a restore drill** exist under `deploy/backup/`.

**Absent:** no staging tier (only dev + prod) · no CD — CI never builds/pushes an
image or deploys · no advisory lock on the scheduler tick (safe at one replica) ·
no integration test against a real Postgres in CI, whose `DATABASE_URL` is an
acknowledged placeholder at `.github/workflows/ci.yml:41`.
Effort: staging ~0.5–1 d · CD ~1–2 d · advisory lock ~0.5 d · CI Postgres ~1 d.

---

## §70 Phase 34 — Philippine Compliance — PARTIALLY IMPLEMENTED

**Framing, per §70's own instruction.** Nothing below is a legal conclusion, and
none is offered. "ABSENT" means _this mechanism is not in the code_ — never
_this system is non-compliant_. Whether any item is required for a given
operator's licence class, size or product mix is a question for a Philippine
compliance professional.

| Area                      | What the code provides                                                                                                                                                                                                                                  | For professional validation                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| DPA — subject rights      | Export `apps/api/src/features/compliance/compliance.routes.ts:72`; erasure `:107`; marker `Customer.erasedAt` `schema.prisma:432`; dedicated permission `libs/auth/src/permissions.ts:374`                                                              | Whether export contents and the redaction field-set satisfy §16; response-time obligations                                                       |
| DPA — retention           | Policy `compliance.routes.ts:132`/`:147`; purge job `apps/api/src/jobs.ts:140`; tested `retention.service.test.ts:156`                                                                                                                                  | Whether the default windows are correct per record class                                                                                         |
| DPA — consent             | **ABSENT** for privacy purposes. The only consent model is co-maker consent — `schema.prisma:2034`, `:2083-2095`                                                                                                                                        | Whether consent capture at onboarding is required                                                                                                |
| DPA — notice / DPO        | **ABSENT** — no DPO field, no privacy notice, no acceptance record                                                                                                                                                                                      | Whether a recorded notice/DPO contact is required                                                                                                |
| AMLA — screening          | `libs/screening/src/index.ts:37` provider interface, `:50` mock; empty subject returns `REVIEW` not `CLEAR` (`:77-79`); watchlist rows trimmed after a bug where padding downgraded a `MATCH` (`:89-91`)                                                | Whether substring matching on a local list is adequate; **`AML_PROVIDER` defaults to `MOCK`** (`deploy/docker/docker-compose.yml:94`)            |
| AMLA — enforcement        | Unresolved `MATCH` hard-blocks loan application — `apps/api/src/features/loans/loans.service.ts:263-273`; admin override posts a superseding row                                                                                                        | Whether admin override with an audit row is sufficient control                                                                                   |
| AMLA — retention floor    | `AMLA_AUDIT_FLOOR_DAYS = 1825`, warned not enforced — `retention.service.ts:71`, `:110-113`                                                                                                                                                             | Whether 5 years is right per record class; whether a warning suffices where a block is expected                                                  |
| AMLA — CDD / risk / PEP   | KYC doc sets `libs/kyc/src/index.ts:33`, `:55`; declarations snapshotted as asked `libs/kyc/src/declarations.ts:8-12`. **No structured risk rating and no PEP flag** — grep for `riskRating`/`CDD`/`EDD` returns nothing                                | Whether unstructured questionnaire answers meet CDD/EDD record-keeping                                                                           |
| AMLA — CTR / STR          | **ABSENT** — no threshold monitoring, no AMLC report format                                                                                                                                                                                             | Whether covered/suspicious transaction reporting is required                                                                                     |
| CIC                       | **ABSENT** — no export, no field mapping                                                                                                                                                                                                                | Whether CIC submission applies                                                                                                                   |
| BSP                       | **ABSENT as a report format.** DORSI is the adjacent control that does exist (`apps/api/src/features/dorsi`), fail-closed when equity is unconfigured                                                                                                   | Which circulars apply; whether DORSI caps are correct                                                                                            |
| SEC                       | **ABSENT** — no company-registration fields. `libs/licensing` is _software_ licensing, not regulatory                                                                                                                                                   | Whether SEC reporting applies                                                                                                                    |
| Consumer — disclosure     | Truth-in-Lending block **is** rendered into the agreement PDF — `libs/pdf/src/agreement.ts:148`, citing RA 3765 at `:151`, itemised `:154-166`, schedule table `:168-191`                                                                               | Whether itemisation matches the prescribed RA 3765 form and ordering                                                                             |
| Consumer — effective rate | **NOT COMPUTED.** No `effectiveRate`/`IRR` calculation exists in `libs/`. Only the nominal annual rate is stored — `schema.prisma:1202-1203`                                                                                                            | **Highest-value item here.** Flat/add-on is the actual product; `compliance.md:81-93` works an example where nominal and effective differ by ~2× |
| Consumer — complaints     | **ABSENT** — no complaint/dispute model or workflow                                                                                                                                                                                                     | Whether a complaints mechanism is mandated                                                                                                       |
| E-Commerce Act            | Borrower/officer e-signature with **source IP at signing** `schema.prisma:1173-1174`, delegation provenance `:1178-1181`, and **`agreementHash`** — SHA-256 of the PDF as rendered at signing, to detect post-signature tampering `:1195-1197`          | Whether canvas PNG + IP + SHA-256 constitutes a valid e-signature under RA 8792                                                                  |
| Mortgage (REM)            | Instrument captured — `model Property` `schema.prisma:1069-1091` (`titleNumber`, `taxDecNumber`, appraised value). **Registration/annotation not modelled**                                                                                             | Whether Registry-of-Deeds annotation tracking is required                                                                                        |
| Chattel                   | Instrument captured — `model Vehicle` `schema.prisma:1046-1067` (plate, chassis, engine). **The word "chattel" appears nowhere in code**; no LTO encumbrance field                                                                                      | Whether chattel-mortgage registration must be tracked                                                                                            |
| Insurance                 | Expiry tracking **is** implemented — `AnnualDocumentType` `schema.prisma:2977-2988` (`CAR_INSURANCE`, `FIRE_INSURANCE`), 30-day reminder job with `lastReminderAt` guard `:2973-2975`. **No policy number, insurer, sum insured, or credit-life model** | Whether credit-life and policy-level detail must be recorded                                                                                     |

**On `compliance.md` itself.** It is honest and largely accurate — it disclaims
legal advice at `:3-6` and maintains its own "Not implemented" table at `:70-79`.
Verified: CIC/BSP/SEC MISSING claims are correct; chattel/mortgage PARTIAL is if
anything generous; the effective-rate concern is correct and **understated** (no
EIR computation exists at all). One claim is **too pessimistic** — insurance
"expiry alerting not confirmed" (`:79`) — alerting is implemented. Corrected
below.

**One claim-vs-code gap worth surfacing to someone qualified**, flagged and not
adjudicated: the marketing pages sell "BSP reports"
(`apps/marketing/src/pages/Pricing.tsx:137`) and "BSP-aligned compliance reports"
(`Home.tsx:207`) while no BSP report generator exists. That is a commercial and
legal question, not a technical defect, and it is out of this audit's remit to
resolve — but it should not stay invisible.

---

## §71 Phase 35 — Data Privacy — EXISTS — NEEDS HARDENING

**The §71 critical rule holds: regulated financial records are not deleted for a
PII request.** Verified directly rather than inferred.

The erasure path is a field-level overwrite of the `Customer` row only —
`apps/api/src/features/compliance/compliance.service.ts:323-371`: a two-statement
transaction that `customer.update`s 25 PII fields to placeholders (`:324-363`)
and deactivates the linked user (`:367-370`). **There is no `.delete(` or
`.deleteMany(` anywhere in `compliance.service.ts`.** Retained tables are
enumerated back to the operator — `:396-407` (`LoanApplication`, `LoanSchedule`,
`LoanPayment`, `JournalEntry`, `JournalLine`, `AuditEvent`, `Contribution`,
`SavingsTransaction`, `AmlScreening`, …).

The schema independently forecloses the cascade route: `LoanApplication`
(`schema.prisma:1299`), `Contribution` (`:2787`), `SavingsTransaction` (`:2811`)
and `CoMaker` (`:2124`) are all `onDelete: Restrict`, and **there is no
`DELETE /customers/:id` route at all** — with the reasoning at
`apps/api/src/features/customers/customers.routes.ts:166-170`. Post-erasure the
record is closed to writes so PII cannot be reintroduced —
`customers.service.ts:230`, surfaced as 409 at `customers.routes.ts:159-160`.

**Per requirement**

- **Export** — EXISTS — GOOD. `compliance.service.ts:120-247` fans out across 12
  tables; route `compliance.routes.ts:71-104` gated on `admin.compliance`;
  delivered as an attachment `compliance.controller.ts:46-50`.
- **Access requests** — PARTIAL. The export _is_ the mechanism, with a free-text
  `reason` (`compliance.controller.ts:36`). **No DSAR tracking model** — no
  received date, no statutory clock, no fulfilment status.
- **Soft erasure** — EXISTS, with real gaps. 25 fields cleared
  (`compliance.service.ts:295-321`); `dateOfBirth` and `monthlyIncome`
  deliberately retained (`:355-359`). **PII survives elsewhere**: `CoMaker`
  name/phone/email/address/government ID (`schema.prisma:2066-2073`), `User.email`
  (`:25` — the row is only deactivated), `Notification.recipient` (`:1928`),
  `PreAssessment.prospectPhone/Email` (`:2329-2330`), and `AuditEvent.payload`
  free-form JSON may hold before/after PII from earlier edits.
- **A documented promise that is not implemented.** `compliance.service.ts:406`
  tells the operator that KYC uploads are "cleared separately by retention job".
  **No such job exists** — the only retention job deletes exactly three tables
  (`retention.service.ts:196`, `:202`, `:208`). Uploaded ID scans and payslips of
  an erased customer remain on disk indefinitely. This is the most substantive
  finding in this phase: the receipt asserts a deletion that never happens.
  Severity **P1**.
- **Retention** — EXISTS — GOOD but narrow: three tables only, nightly job at
  `apps/api/src/jobs.ts:138-155`. See the §56 section for the append-only tension
  and the advisory AMLA floor.
- **PII minimisation** — PARTIAL. Prod log redaction `app.ts:57-72`; structured
  rows rather than raw records into the LLM (`assistant/schemas.ts:5-8`). Absent:
  role-scoped PII projection, column-level encryption for `governmentIdNumber`
  (plain `String` at `schema.prisma:408`, indexed at `:482`), and redaction is
  prod-only.
- **Audit of privacy actions** — EXISTS — GOOD. `CUSTOMER_DATA_EXPORT` with
  per-table row counts (`compliance.service.ts:208-229`), `CUSTOMER_ERASE` with
  reason and exact `fieldsCleared` (`:377-389`), retention policy/purge
  (`retention.service.ts:137`, `:235`). Caveat: the same swallow-on-failure as
  everywhere else.
- **Impersonation audit** — EXISTS — GOOD; the strongest area in the audit.
  Dual-sided recording — platform side `platform.service.ts:808-820`, tenant side
  `:826-840` with the reasoning at `:823-825` ("otherwise impersonation becomes a
  stealth backdoor"). **Every subsequent action is attributed**, not just session
  start — `schema.prisma:1795-1796` auto-stamped by
  `audit-log.repository.ts:78-92`, wired per-request across ~15 feature plugins.
  Sessions are bounded (default 15 min, `platform.service.ts:782`) and borrower
  impersonation is blocked (`:759-766`). Gap: the impersonation columns are
  **not exposed on the audit API wire format** — `apps/api/src/features/audit/schemas.ts:38-39`
  — so a tenant admin cannot see vendor access without direct DB access.
- **Tenant isolation** — EXISTS — GOOD. Schema-per-tenant,
  `libs/db/src/multi-tenant-plugin.ts:88-152`; JWT `tenant` claim regex-validated
  `:102-111`; dedicated test `apps/api/src/features/tenancy/tenant-isolation.test.ts`.

**Remaining work:** KYC/upload purge on erasure (~1–2 d — closes a promise the
API already makes) · cross-table PII cascade (~1 d) · DSAR tracking model
(~2–3 d) · consent/lawful-basis records (~2–3 d) · expose impersonation on the
audit wire format (~2 h).

---

## Tracker corrections made

Seven stale items, **all in the same direction** the previous six were: the
document said outstanding, the code said shipped.

**`gap-matrix.md`**

| Row          | Was                                                 | Now                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI      | "PARTIAL — 112 of 337, coverage 33%"                | **EXISTS — GOOD**, 328 of 339 — the ratchet is `DOCUMENTED = 328` at `apps/api/src/lib/openapi.coverage.test.ts:88`, and `roadmap.md` 3.4 already said so. The two trackers contradicted each other and the matrix was the wrong one. |
| AI assistant | "§51 AI audit trail not stored"                     | 4 of 7 §51 fields **are** stored; prompt version, output and decision context are not. Too pessimistic.                                                                                                                               |
| IFRS-9 ECL   | "assumptions not versioned"                         | Accurate, and extended: the re-run double-post hazard and the missing product/branch/vintage breakdowns were not recorded. Status → EXISTS — NEEDS HARDENING.                                                                         |
| Audit trail  | **EXISTS — GOOD**, "add request_id, ip, user_agent" | The note was **correct** — this is the one row the audit confirmed rather than corrected. Status → EXISTS — NEEDS HARDENING, because five of thirteen fields and five financial actions are missing.                                  |

Tally table updated accordingly. It also had a pre-existing off-by-one: PARTIAL
was listed as 2 against 3 actual rows.

**`roadmap.md`**

- Six rows in the §86-I table carried no ✅ despite having shipped: 2.3 (standing
  reconciliation — `libs/db/src/lib/reconciliation.ts` exists), 2.4 (FK
  CASCADE→RESTRICT — migrations `20260811160000_coop_money_restrict` and
  `20260814090000_financial_record_restrict`), 3.1 (object storage — `libs/storage/`),
  3.2 (Playwright — `apps/web/e2e/`), 3.5 (restore drill —
  `docs/modernization/disaster-recovery.md`), 4.1 (Nx boundaries — the rule is
  live in `eslint.config.mjs:167`).
- The Phase 2 section still read "2.3 not started" and "2.4 not started".
- "Immediate next step" pointed at Phase 2.1, which the same document marks ✅
  COMPLETE.
- New entries added for genuinely open work that was invisible: see below.

**Left alone as instructed:** roadmap step 4.4 and the gap matrix's
consolidated-exposure row — another branch owns that contradiction.

---

## Limitations — what could not be determined from code alone

1. **The canonical lists are not in the repository.** The master prompt is not
   checked in (searched all `*.md`). The thirteen §56 audit fields were supplied
   in the task brief and verified one by one. The **eleven** §48 events and the
   **seventeen** §56 actions were not enumerated anywhere available, so those two
   sections compare against the expected set and say so. If the canonical lists
   matter, check them in — this ambiguity will recur at every audit.
2. **Every §70 item** is a mechanism finding only. Whether any of it satisfies
   Philippine law is outside both this audit's remit and its competence.
3. **The S3 storage path has still never run against a live endpoint**, so
   §68's object-storage half is verified as code, not as behaviour.
4. **No runtime verification was performed** — this is a static audit. The ECL
   double-post, the notification blocking risk and the dev-log PII exposure are
   all reasoned from code paths, not reproduced. The ECL one in particular would
   be worth reproducing before scheduling the fix.
5. **`AuditEvent.payload` contents were not surveyed.** Whether `old_value`,
   `new_value` and `reason` are present _in practice_ per action would need a
   data survey against a populated database.
