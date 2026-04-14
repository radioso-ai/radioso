import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";

export class AttributeMatchScoringService {
  apply(input: {
    candidates: RetrievedCandidate[];
    parsedQuery: ParsedQueryInterpretation;
    signalPolicies: Array<{ signalKey: string; enabled: boolean; mode: "boost_only" | "hard_filter" }>;
  }): {
    candidates: RetrievedCandidate[];
    appliedConstraints: AppliedConstraint[];
    fallbackApplied: boolean;
  } {
    return {
      candidates: input.candidates,
      appliedConstraints: input.parsedQuery.constraints.map((constraint) => ({
        signalKey: constraint.signalKey,
        mode: "boost_only",
        outcome: "skipped",
        summary: constraint.summary,
      })),
      fallbackApplied: false,
    };
  }
}
