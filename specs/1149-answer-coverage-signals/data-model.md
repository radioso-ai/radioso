# Data Model: Answer Coverage Signals

## `AnswerCoverageAssessment`

| Field | Type | Rule |
|---|---|---|
| availability | `assessed | not_recorded | failed | invalid` | Only `assessed` can have coverage/reason or trigger rules. |
| coverage | `answered | partial | unanswered | unclear` | Required when assessed. |
| reason | `sufficient_evidence | insufficient_evidence | conflicting_evidence | ambiguous_request | intentional_scope_boundary` | Required when assessed. |
| unresolvedRequest | string optional | Conversation data; present for missing/unclear information; never logged/metric-labelled. |
| contextualizedRequest | string | Authorized history/debug display copy of the assessed request; never operationally logged. |
| originatingTurnId | string | Immutable recorded-turn correlation. |
| originatingRequestId | string | Idempotency and aggregation correlation. |
| schemaVersion | integer | Producer output provenance. |
| assessedAt | ISO timestamp | Audit/debug provenance. |

## `CoverageInteractionDecision`

Assessment-correlated recorded evaluation: `not_evaluated` is distinct from an
evaluation that yielded `no_match`; evaluated entries retain execution order,
the consumed signal, directive/routine identity, and `applied | offered |
activated | skipped | suppressed | no_match` decision with a bounded reason code.
The optional generic routine lifecycle reference is an authorized navigable
execution link, not merely an opaque display id. Decisions never contain request
text and routine lifecycle never updates the assessment.

`assessmentRequestId` and `targetMessageId` are required navigation references.
`routineExecutionId` is present only for an execution that began. Migration 171
stores assessments and reaction traces; migration 172 stores directive and
routine coverage criteria.

## Presented outcome

An assessed result adds `coverage_partial`, `coverage_unanswered`,
`coverage_unclear`, or `coverage_unavailable` to the turn-outcome vocabulary.
These do not claim a no-context refusal. `no_context_refusal` continues to mean
the retrieval answer path actually declined, and historical absence retains the
former status.

## Pulse projection

Per eligible originating question: exactly one assessed bucket, an unassessed or
legacy state, reason breakdown, content-gap eligibility, and authorized evidence
references. The recurrence unit is an eligible originating request and distinct
conversation; duplicate persistence deliveries coalesce by originating request.

An assessment is provisional until the assistant-turn transaction commits the
exact reply it evaluated. Pulse treats a present but unconfirmed assessment as
unassessed and excludes it from gap eligibility; it never infers an association
from a later reply. Rows with no assessment remain legacy evidence.
