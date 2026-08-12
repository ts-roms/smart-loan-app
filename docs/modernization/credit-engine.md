# Credit Engine

Scoring, decisioning and approval. Read from the code on 11 Aug 2026.

---

## Pipeline as built

```
Application
   ↓  AML gate — latest screening MATCH blocks unless OVERRIDDEN
   ↓  Archived / erased customer gate
   ↓  One-live-loan gate
   ↓  KYC declarations validated (partial allowed at apply)
   ↓
Credit score  ──  libs/credit-scoring
   ↓              catalog-driven; weights → points → 300–850 → tier
   ↓
Decision rules ── libs/decisioning
   ↓              priority-ordered, first match wins
   ↓
AUTO_APPROVE → SUBMITTED (advisory)   AUTO_REJECT → REJECTED   else SUBMITTED
   ↓
Approval chain (LoanApprovalStep) → decide() → APPROVED / REJECTED
   ↓
Disburse
```

**AUTO_APPROVE does not approve.** It downgrades to SUBMITTED and rides along as
the decision reason. The code is explicit about why: an auto-approved loan is
"already money out the door", so a human still says yes. AUTO_REJECT _is_ final
— declining is not the risk being guarded against, and the rules that reject
(AML hard-block, F tier) are compliance controls that should fire without
waiting for a queue.

## Scoring

`libs/credit-scoring` — catalog-driven since the questionnaire work.

| Concept             | Implementation                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Total raw points    | `TOTAL_RAW_POINTS = 150`, fixed                                                          |
| Factors             | `SurveyFactor` rows: relative **weight**, not points                                     |
| Points              | derived — `resolveFactorPoints` apportions the 150 across _active_ factors by weight     |
| Questions           | `SurveyQuestionDef`, kinds `CHOICE` / `NUMBER` / `BOOLEAN`                               |
| Behavioural factors | `computed: true` — on-time rate, defaults — scored from loan history, no survey question |
| Scale               | 300–850                                                                                  |
| Tiers               | A ≥ 750, B ≥ 700, C ≥ 600, D ≥ 500, F below                                              |
| Bureau buckets      | EXCELLENT / GOOD / FAIR / POOR                                                           |

Weights rather than points is the load-bearing choice: adding a factor takes
points from the others rather than growing the scale, so a 720 means the same
thing before and after an edit and decision-rule thresholds keep their meaning.

An inactive factor contributes nothing and does not dilute the others.

## Decision rules

`DecisionRule`: `name` (unique), `priority` (default 500), `conditions` (JSON,
**all** must match), `action`, `reason`, `active`.

Actions: `AUTO_APPROVE` | `AUTO_REJECT` | `MANUAL_REVIEW`.

Context available to conditions: product code, principal, term, rate, tier,
credit score, AML status, KYC completeness, customer age, monthly income,
existing active loan count.

## Explainability — §20

Returned on apply: verdict, reason, the matched rule, the evaluation context and
the non-rule gates (AML match, KYC completeness, missing/rejected documents).
Snapshotted onto the loan: `creditScoreAtApply`, `tierAtApply`,
`decisionReason`.

## Gaps against §19–§22

| Requirement                          | Status                 | Note                                                                                                                                                                                    |
| ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explainable decisions                | **EXISTS**             | verdict + reason + matched rule + gates                                                                                                                                                 |
| Score/tier snapshot on the loan      | **EXISTS**             | `creditScoreAtApply`, `tierAtApply`                                                                                                                                                     |
| Rule versioning                      | **EXISTS**             | `DecisionRule.version` + append-only `DecisionRuleVersion`. Only outcome-changing edits mint a version — a rename does not                                                              |
| Effective dating                     | **EXISTS**             | `[effectiveFrom, effectiveTo)` per version; `GET /decision-rules/as-of?at=` rebuilds the whole set at a moment, paused rules included                                                   |
| Decision reproducibility             | **EXISTS**             | `LoanApplication.decisionRuleId/Name/Version` + `decisionContext`; `versionsToEvaluable` replays a historical set through the same evaluator. Stamped even on manual review — see below |
| Scorecard versioning                 | **EXISTS**             | `ScoringCatalogVersion` — the WHOLE catalog per version, since points normalize against a fixed total. `CreditScore.catalogVersion` / `SurveyResponse.catalogVersion` stamp it          |
| `CONDITIONAL_APPROVAL` as a decision | **MISSING**            | §19 lists four decisions; the system has three actions and a separate approval chain                                                                                                    |
| Approval matrix by amount band       | **PARTIAL**            | `LoanApprovalStep` chain exists and is configurable, but amount-banded levels (§22) not confirmed                                                                                       |
| Self-approval prevention             | **NEEDS VERIFICATION** | approval chain exists; whether an approver can approve their own submission was not traced                                                                                              |
| DTI / LTV as first-class rules       | **PARTIAL**            | conditions can express them from context, but there is no DTI/LTV band in product config                                                                                                |

**Closed 11 Aug 2026** (migration `20260811180000_decision_rule_versioning`),
with the scorecard following on 12 Aug (`20260812090000`).

## How it works

Editing a rule closes the standing version and opens the next, in one
transaction. Two admins saving at once both compute the same next number, and
the unique index on `(ruleId, version)` makes the loser's transaction roll back
rather than leaving the rule with two "current" texts — the same
claim-don't-check shape as every other concurrent path in this codebase.

Only **decisive** fields mint a version: `conditions`, `action`, `priority`,
`reason`, `active`. A rename or a reworded description updates in place. This is
deliberate: a history that logs cosmetic edits is one an auditor has to open and
discard, which buries the entries that matter.

DELETE **retires** rather than erases. Dropping the row would cascade its
history away and leave every loan citing it pointing at nothing — the decisions
would not become wrong, they would become unexplainable. Same call the customer
records made.

### An unplanned improvement

The stamp is written on every path, including manual review. That turned out to
matter more than expected: `decisionReason` was only ever set for decided loans,
so a loan **routed to manual review recorded nothing at all** about why. A
SUBMITTED loan now names the rule that routed it — verified end to end, where a
probe application came back stamped `KYC incomplete → manual v1` with the full
context the engine saw.

## Scorecard versioning

Same question, different shape — and the audit's framing of it was too
strong, which is worth recording because building on it would have
produced the wrong thing.

`CreditScore.breakdown` was already good. It freezes each factor's label,
its resolved maxPoints, the 0..1 weight achieved, the points, and a
human-readable source line. **A stored score already says what it was
made of.** What it could not say was what it was made _by_, and hence:

- whether two scores are comparable at all;
- what the QUESTIONS offered — the breakdown records the factor, not the
  question, so editing a `CHOICE` option's weight leaves "why did
  answering 'employed 2 years' score 0.6?" unanswerable;
- which factors were switched **off** — an inactive factor is simply
  absent, indistinguishable from one that scored zero;
- who changed the scorecard, when, or why.

`ScoringCatalogVersion` closes those. The versioned unit is the **whole
catalog**, unlike a decision rule, and that difference is forced rather
than chosen: factor points are normalized against a fixed 150-point
total, so raising one factor's weight lowers every other factor's
points. There is no edit that touches one factor, and a per-factor
history would describe a change that did not happen while hiding the one
that did.

The snapshot is stored in the shape `@loan/credit-scoring` consumes, so
replaying a historical scorecard is a function call — verified against
the dev database, where v1 (9 factors / 7 questions) rescored through
`computeCreditScore` directly.

The baseline is minted at **boot**, not by the migration, because the
snapshot must include the `DEFAULT_CATALOG` fallback for a tenant whose
tables are still empty. Reproducing that mapping in SQL would duplicate
it, and duplicated mappings drift.

Read paths are `scoring.read`, not the admin permission: an officer
explaining a customer's score needs to know which scorecard produced it,
and what that scorecard said if it was not the current one.

    GET /scoring/catalog/versions           list, snapshots omitted
    GET /scoring/catalog/versions/:version  one, snapshot included

### Still open

- **No UI yet.** The record and the API exist; the questionnaires admin
  page shows no version badge and no history panel. Deliberate — the
  audit gap was about the record, not the screen — but it means the
  history is currently reachable only by API.
- Scheduled activation. `effectiveFrom` records when a version **took** effect,
  not when it **will**; a rule that should start on the 1st still has to be
  switched on by hand. Different feature, and worth doing separately rather than
  overloading these columns.
