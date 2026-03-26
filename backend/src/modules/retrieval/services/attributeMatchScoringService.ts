import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryConstraint, ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import { metadataPathFromSignalKey, type RetrievalSignalPolicy } from "../../settings/domain/retrievalSettings.js";

type ConstraintMatcher = (candidate: RetrievedCandidate, constraint: ParsedQueryConstraint) => boolean;

const isLocationValue = (
  value: ParsedQueryConstraint["value"],
): value is { matchKey: string; displayName: string } => "matchKey" in value;

const isMoneyValue = (
  value: ParsedQueryConstraint["value"],
): value is { amount: number; currencyCode: string | null } => "amount" in value;

const isDateValue = (value: ParsedQueryConstraint["value"]): value is { date: string } => "date" in value;

const isRawValue = (value: ParsedQueryConstraint["value"]): value is { raw: string } => "raw" in value;

const signalMatcherRegistry: Record<string, ConstraintMatcher> = {
  document_location: (candidate, constraint) => {
    if (!isLocationValue(constraint.value)) {
      return false;
    }
    const locationValue = constraint.value;

    return Boolean(
      candidate.structuredAttributes?.locations.some(
        (location) =>
          location.confidence >= HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold &&
          location.matchKey === locationValue.matchKey,
      ),
    );
  },
  document_amount: (candidate, constraint) => {
    if (!isMoneyValue(constraint.value)) {
      return false;
    }
    const moneyValue = constraint.value;

    return Boolean(
      candidate.structuredAttributes?.moneyValues.some((money) => {
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
      }),
    );
  },
  document_date: (candidate, constraint) => {
    if (!isDateValue(constraint.value)) {
      return false;
    }
    const dateValue = constraint.value;

    return Boolean(
      candidate.structuredAttributes?.datePoints.some((datePoint) => {
        if (datePoint.confidence < HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold) {
          return false;
        }
        if (constraint.operator === "eq") {
          return datePoint.value === dateValue.date;
        }
        if (constraint.operator === "gte") {
          return datePoint.value >= dateValue.date;
        }
        if (constraint.operator === "lte") {
          return datePoint.value <= dateValue.date;
        }
        return false;
      }),
    );
  },
  document_period: (candidate, constraint) => {
    if (!isDateValue(constraint.value)) {
      return false;
    }
    const dateValue = constraint.value;

    return Boolean(
      candidate.structuredAttributes?.dateRanges.some((dateRange) => {
        if (dateRange.confidence < HYBRID_RETRIEVAL_DEFAULTS.attributeValueHardFilterConfidenceThreshold) {
          return false;
        }
        if (constraint.operator === "eq") {
          return dateRange.start <= dateValue.date && dateRange.end >= dateValue.date;
        }
        if (constraint.operator === "gte") {
          return dateRange.end >= dateValue.date;
        }
        if (constraint.operator === "lte") {
          return dateRange.start <= dateValue.date;
        }
        return false;
      }),
    );
  },
};

export class AttributeMatchScoringService {
  apply(input: {
    candidates: RetrievedCandidate[];
    parsedQuery: ParsedQueryInterpretation;
    signalPolicies: RetrievalSignalPolicy[];
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
    signalPolicies: RetrievalSignalPolicy[];
    allowHardFilter: boolean;
  }) {
    const appliedConstraints: AppliedConstraint[] = [];
    let candidates = input.candidates.map((candidate) => ({
      ...candidate,
      attributeMatchScore: candidate.attributeMatchScore ?? 0,
    }));

    for (const constraint of input.parsedQuery.constraints) {
      const policy = input.signalPolicies.find((item) => item.signalKey === constraint.signalKey);
      if (!policy || !policy.enabled) {
        appliedConstraints.push({
          signalKey: constraint.signalKey,
          mode: policy?.mode ?? "boost_only",
          outcome: "skipped",
          summary: constraint.summary,
        });
        continue;
      }

      const useHardFilter =
        input.allowHardFilter &&
        policy.mode === "hard_filter" &&
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
        signalKey: constraint.signalKey,
        mode: policy.mode,
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
    const matcher = signalMatcherRegistry[constraint.signalKey];
    if (matcher) {
      return matcher(candidate, constraint);
    }

    return this.matchesMetadataConstraint(candidate, constraint);
  }

  private matchesMetadataConstraint(candidate: RetrievedCandidate, constraint: ParsedQueryConstraint): boolean {
    const metadataPath = metadataPathFromSignalKey(constraint.signalKey);
    if (!metadataPath || !isRawValue(constraint.value)) {
      return false;
    }

    const metadataValue = getValueAtPath(candidate.metadata ?? {}, metadataPath);
    if (!isScalarMetadataValue(metadataValue)) {
      return false;
    }

    return normalizeMetadataValue(metadataValue) === normalizeMetadataValue(constraint.value.raw);
  }
}

const getValueAtPath = (metadata: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, metadata);

const isScalarMetadataValue = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const normalizeMetadataValue = (value: string | number | boolean | null): string =>
  String(value).trim().toLowerCase();
