import type {
  AnswerCoverage,
  AnswerCoverageCriteria,
  AnswerCoverageReason,
} from "@radioso/conversation-contract";

/**
 * The eight-value classification a coverage judge (the answer envelope head,
 * or its shadow assessor) emits on the wire, mapped to the decomposed
 * `{coverage, reason}` pair the rest of the system reasons about (#1260).
 *
 * This lives here rather than `@radioso/conversation-contract` because that
 * package is types-only (`index.d.ts`, no runtime export) and cannot carry a
 * value. Backend's `answerCoverage/contracts.ts` imports this table instead of
 * defining its own, and this package's steering-prompt renderer uses it to
 * expand a directive's `coverageCriteria` into the exact enum values the
 * answer model can emit. The dependency stays one-directional: backend depends
 * on this package, this package depends on the contract, and neither this
 * package nor `conversation-engine` depends on the backend.
 */
export const ANSWER_COVERAGE_CLASSIFICATIONS = {
  answered_sufficient_evidence: { coverage: "answered", reason: "sufficient_evidence" },
  partial_insufficient_evidence: { coverage: "partial", reason: "insufficient_evidence" },
  partial_conflicting_evidence: { coverage: "partial", reason: "conflicting_evidence" },
  partial_intentional_scope_boundary: { coverage: "partial", reason: "intentional_scope_boundary" },
  unanswered_insufficient_evidence: { coverage: "unanswered", reason: "insufficient_evidence" },
  unanswered_conflicting_evidence: { coverage: "unanswered", reason: "conflicting_evidence" },
  unanswered_intentional_scope_boundary: { coverage: "unanswered", reason: "intentional_scope_boundary" },
  unclear_ambiguous_request: { coverage: "unclear", reason: "ambiguous_request" },
} as const satisfies Record<string, { coverage: AnswerCoverage; reason: AnswerCoverageReason }>;

export type AnswerCoverageClassification = keyof typeof ANSWER_COVERAGE_CLASSIFICATIONS;

export const ANSWER_COVERAGE_CLASSIFICATION_VALUES = Object.keys(ANSWER_COVERAGE_CLASSIFICATIONS) as [
  AnswerCoverageClassification,
  ...AnswerCoverageClassification[],
];

/**
 * Inverts {@link ANSWER_COVERAGE_CLASSIFICATIONS} back to its eight-value key
 * from a `coverage`/`reason` pair. Used to label the shadow agreement
 * observation (#1260, FR-020) with the same bounded enum the head and the
 * assessor both classify against, rather than re-deriving a coarser signal.
 */
export const answerCoverageClassificationKeyFor = (
  signal: { coverage: AnswerCoverage; reason: AnswerCoverageReason },
): AnswerCoverageClassification | undefined => {
  const entry = (Object.entries(ANSWER_COVERAGE_CLASSIFICATIONS) as [
    AnswerCoverageClassification,
    { coverage: AnswerCoverage; reason: AnswerCoverageReason },
  ][]).find(([, value]) => value.coverage === signal.coverage && value.reason === signal.reason);
  return entry?.[0];
};

/**
 * Every eight-value classification compatible with an authored coverage
 * criteria — the exact set the criteria's coverage/reasons pair allows, all
 * compatible reasons when `reasons` is absent. Used to (1) render a
 * coverage-conditional steering rule against the enum the answer model
 * actually emits rather than the coarser `AnswerCoverage` word (#1260), and
 * (2) test whether an already-known verdict satisfies a directive's criteria
 * without re-deriving the compound key.
 */
export const expandAnswerCoverageCriteria = (
  criteria: AnswerCoverageCriteria,
): AnswerCoverageClassification[] =>
  ANSWER_COVERAGE_CLASSIFICATION_VALUES.filter((key) => {
    const value = ANSWER_COVERAGE_CLASSIFICATIONS[key];
    return criteria.coverage.includes(value.coverage)
      && (criteria.reasons === undefined || criteria.reasons.includes(value.reason));
  });

/** Whether an already-known `{coverage, reason}` verdict satisfies an authored criteria. */
export const answerCoverageCriteriaMatches = (
  criteria: AnswerCoverageCriteria,
  assessment: { coverage: AnswerCoverage; reason: AnswerCoverageReason },
): boolean =>
  criteria.coverage.includes(assessment.coverage)
  && (criteria.reasons === undefined || criteria.reasons.includes(assessment.reason));
