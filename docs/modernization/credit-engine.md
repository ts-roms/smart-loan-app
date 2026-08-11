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

| Requirement                          | Status                 | Note                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explainable decisions                | **EXISTS**             | verdict + reason + matched rule + gates                                                                                                                                                                                                                                                                             |
| Score/tier snapshot on the loan      | **EXISTS**             | `creditScoreAtApply`, `tierAtApply`                                                                                                                                                                                                                                                                                 |
| **Rule versioning**                  | **MISSING**            | `DecisionRule` has no `version`                                                                                                                                                                                                                                                                                     |
| **Effective dating**                 | **MISSING**            | no `effectiveFrom` / `effectiveTo`                                                                                                                                                                                                                                                                                  |
| **Decision reproducibility**         | **PARTIAL — P1**       | the score is stored, but not _which version of which rule_ fired. Editing a rule silently changes what a historical decision would have been, and the original cannot be replayed. §21: "Never modify historical decisions when a rule changes" — the decisions are not modified, but they are no longer explicable |
| Scorecard versioning                 | **MISSING**            | same problem for the catalog: an edited factor weight changes what a stored score _means_, though stored breakdowns retain their computed values                                                                                                                                                                    |
| `CONDITIONAL_APPROVAL` as a decision | **MISSING**            | §19 lists four decisions; the system has three actions and a separate approval chain                                                                                                                                                                                                                                |
| Approval matrix by amount band       | **PARTIAL**            | `LoanApprovalStep` chain exists and is configurable, but amount-banded levels (§22) not confirmed                                                                                                                                                                                                                   |
| Self-approval prevention             | **NEEDS VERIFICATION** | approval chain exists; whether an approver can approve their own submission was not traced                                                                                                                                                                                                                          |
| DTI / LTV as first-class rules       | **PARTIAL**            | conditions can express them from context, but there is no DTI/LTV band in product config                                                                                                                                                                                                                            |

**The P1 here is reproducibility.** Everything else on this list is an
enhancement; rule versioning is the difference between being able and unable to
answer "why was this loan declined in March" after the rule has been edited.

## Recommended change

Add to `DecisionRule`: `version` (incrementing), `effectiveFrom`,
`effectiveTo` (nullable). Never mutate a rule in place — supersede it. Snapshot
`ruleId + version` and `catalogVersion` onto the loan at decision time. That
makes a decision replayable, which is what §20's "store the exact rule version /
scorecard version used at decision time" asks for.

Sequenced as roadmap 4.3 rather than P0 because nothing about it risks money
today; it risks the ability to explain a past decision to a regulator or a
declined applicant.
