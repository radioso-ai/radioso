# Coverage Wire Contract

`packages/conversation-contract` exports the shared runtime types. HTTP DTOs and
frontend normalization use the same serialized names.

```ts
type AnswerCoverageAvailability = "assessed" | "not_recorded" | "failed" | "invalid";
type AnswerCoverage = "answered" | "partial" | "unanswered" | "unclear";
type AnswerCoverageReason =
  | "sufficient_evidence"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "ambiguous_request"
  | "intentional_scope_boundary";

interface AssessedAnswerCoverage {
  availability: "assessed";
  coverage: AnswerCoverage;
  reason: AnswerCoverageReason;
  contextualizedRequest: string;
  unresolvedRequest?: string;
  originatingTurnId: string; // existing persisted turn/message reference
  originatingRequestId: string; // existing persisted visitor request/message reference
  schemaVersion: number;
  assessedAt: string;
}
interface UnassessedAnswerCoverage {
  availability: Exclude<AnswerCoverageAvailability, "assessed">;
  contextualizedRequest?: string;
  originatingTurnId: string;
  originatingRequestId: string;
  schemaVersion?: number;
  assessedAt?: string;
}
type AnswerCoverageAssessment = AssessedAnswerCoverage | UnassessedAnswerCoverage;
/* serialized shape:
interface AnswerCoverageAssessmentLegacyShape {
  availability: AnswerCoverageAvailability;
  coverage?: AnswerCoverage;
  reason?: AnswerCoverageReason;
  contextualizedRequest?: string;
  unresolvedRequest?: string;
  originatingTurnId: string;
  originatingRequestId: string;
  schemaVersion?: number;
  assessedAt?: string;
}
*/

Valid assessed combinations are: `answered/sufficient_evidence`,
`partial/(insufficient_evidence|conflicting_evidence|intentional_scope_boundary)`,
`unanswered/(insufficient_evidence|conflicting_evidence|intentional_scope_boundary)`,
and `unclear/ambiguous_request`. Validation rejects all other pairs.

interface CoverageInteractionDecision {
  assessmentRequestId: string;
  target: "directive" | "routine";
  targetId?: string;
  decision: "applied" | "offered" | "activated" | "skipped" | "suppressed" | "no_match";
  reasonCode: string;
  targetMessageId: string;
  routineExecutionId?: string;
}
interface CoverageInteractionTrace {
  state: "not_evaluated" | "evaluated";
  consumedAssessment?: Pick<AssessedAnswerCoverage, "coverage" | "reason">;
  decisions: CoverageInteractionDecision[]; // `[]` is evaluated with no match only
}
```

The discriminated assessed state requires coverage, reason, the contextualized
request, durable existing request/turn references, a schema version, and an
assessment timestamp. `coverage` and `reason` are absent for every non-assessed
state. The initial runtime context is `{ answerCoverage?: AnswerCoverageAssessment
}`; its absence preserves existing authored behavior. `interactionTrace` absent
means legacy/not recorded, `state: not_evaluated` means no coverage rule was run,
and `state: evaluated, decisions: []` means evaluated/no match. Transport may
omit optional diagnostic fields for an older record but must represent it as
`not_recorded`, never infer `answered`.

Final presented turns use `coverage_partial`, `coverage_unanswered`,
`coverage_unclear`, or `coverage_unavailable` when a corresponding assessment
is present. `no_context_refusal` remains an actual retrieval refusal, while an
absent historical assessment retains the existing outcome.
