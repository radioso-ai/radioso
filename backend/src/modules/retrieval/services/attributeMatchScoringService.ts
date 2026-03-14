import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryConstraint, ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import type { AttributeFamilyControl } from "../../settings/domain/retrievalSettings.js";

export class AttributeMatchScoringService {
  apply(input: {
    candidates: RetrievedCandidate[];
    parsedQuery: ParsedQueryInterpretation;
    attributeControls: AttributeFamilyControl[];
  }): {
    candidates: RetrievedCandidate[];
    appliedConstraints: AppliedConstraint[];
    fallbackApplied: boolean;
  } {
    const filterResult = this.applyInternal({
      ...input,
      allowHardFilter: true,
    });

    if (
      filterResult.candidates.length > 0 &&
      (input.candidates.length < HYBRID_RETRIEVAL_DEFAULTS.minimumUsefulCandidateCount ||
        filterResult.candidates.length >= HYBRID_RETRIEVAL_DEFAULTS.minimumUsefulCandidateCount) ||
      !filterResult.appliedConstraints.some((constraint) => constraint.mode === "hard_filter")
    ) {
      return filterResult;
    }

    const relaxed = this.applyInternal({
      ...input,
      allowHardFilter: false,
    });

    return {
      ...relaxed,
      fallbackApplied: true,
      appliedConstraints: relaxed.appliedConstraints.map((constraint) =>
        constraint.mode === "hard_filter"
          ? { ...constraint, outcome: "relaxed" }
          : constraint,
      ),
    };
  }

  private applyInternal(input: {
    candidates: RetrievedCandidate[];
    parsedQuery: ParsedQueryInterpretation;
    attributeControls: AttributeFamilyControl[];
    allowHardFilter: boolean;
  }) {
    const appliedConstraints: AppliedConstraint[] = [];
    let candidates = input.candidates.map((candidate) => ({
      ...candidate,
      attributeMatchScore: candidate.attributeMatchScore ?? 0,
    }));

    for (const constraint of input.parsedQuery.constraints) {
      const control = input.attributeControls.find((item) => item.family === constraint.family);
      if (!control || !control.enabled) {
        appliedConstraints.push({
          family: constraint.family,
          mode: control?.mode ?? "boost_only",
          outcome: "skipped",
          summary: constraint.summary,
        });
        continue;
      }

      const useHardFilter =
        input.allowHardFilter &&
        control.mode === "hard_filter" &&
        constraint.confidence >= HYBRID_RETRIEVAL_DEFAULTS.hardFilterConfidenceThreshold;

      const nextCandidates = candidates
        .map((candidate) => ({
          ...candidate,
          matchesConstraint: this.matchesConstraint(candidate, constraint),
        }))
        .filter((candidate) => (useHardFilter ? candidate.matchesConstraint : true))
        .map((candidate) => ({
          ...candidate,
          attributeMatchScore: candidate.attributeMatchScore + (candidate.matchesConstraint ? 0.2 : 0),
          similarity: candidate.similarity + (candidate.matchesConstraint ? 0.2 : 0),
        }))
        .map(({ matchesConstraint, ...candidate }) => candidate);

      candidates = nextCandidates;
      appliedConstraints.push({
        family: constraint.family,
        mode: control.mode,
        outcome: "applied",
        summary: constraint.summary,
      });
    }

    return {
      candidates: candidates.sort((left, right) => right.similarity - left.similarity),
      appliedConstraints,
      fallbackApplied: false,
    };
  }

  private matchesConstraint(candidate: RetrievedCandidate, constraint: ParsedQueryConstraint): boolean {
    const attributes = candidate.structuredAttributes;
    if (!attributes) {
      return false;
    }

    if (constraint.family === "location" && constraint.operator === "match" && this.isLocationValue(constraint.value)) {
      const locationValue = constraint.value;
      return attributes.locations.some(
        (location) =>
          location.confidence >= HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold &&
          location.matchKey === locationValue.matchKey,
      );
    }

    if (constraint.family === "money_value" && this.isMoneyValue(constraint.value)) {
      const moneyValue = constraint.value;
      return attributes.moneyValues.some((money) => {
        if (money.confidence < HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold) {
          return false;
        }
        if (moneyValue.currencyCode && money.currencyCode && moneyValue.currencyCode !== money.currencyCode) {
          return false;
        }
        if (constraint.operator === "lte") {
          return money.amount <= moneyValue.amount;
        }
        if (constraint.operator === "gte") {
          return money.amount >= moneyValue.amount;
        }
        return false;
      });
    }

    if (constraint.family === "date_point" && this.isDateValue(constraint.value)) {
      const compareDate = constraint.value.date;

      const datePointMatch = attributes.datePoints.some((datePoint) => {
        if (datePoint.confidence < HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold) {
          return false;
        }
        if (constraint.operator === "gte") {
          return datePoint.value >= compareDate;
        }
        if (constraint.operator === "lte") {
          return datePoint.value <= compareDate;
        }
        return false;
      });

      if (datePointMatch) {
        return true;
      }

      return attributes.dateRanges.some((dateRange) => {
        if (dateRange.confidence < HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold) {
          return false;
        }
        if (constraint.operator === "gte") {
          return dateRange.end >= compareDate;
        }
        if (constraint.operator === "lte") {
          return dateRange.start <= compareDate;
        }
        return false;
      });
    }

    return false;
  }

  private isLocationValue(value: ParsedQueryConstraint["value"]): value is { matchKey: string; displayName: string } {
    return "matchKey" in value;
  }

  private isMoneyValue(value: ParsedQueryConstraint["value"]): value is { amount: number; currencyCode: string | null } {
    return "amount" in value;
  }

  private isDateValue(value: ParsedQueryConstraint["value"]): value is { date: string } {
    return "date" in value;
  }
}
