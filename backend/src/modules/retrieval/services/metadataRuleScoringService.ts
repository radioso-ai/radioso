import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { AppliedConstraint } from "../domain/queryConstraintTypes.js";
import type {
  MetadataRuleOperator,
  MetadataValueType,
  RetrievalMetadataRule,
} from "../../settings/contracts/retrieval.js";
import { getNormalizedMetadataConditions } from "../../settings/contracts/retrieval.js";
import { isDynamicDateToken, resolveDynamicDateTokenToEpochMs } from "../../settings/contracts/dynamicDateToken.js";
import { applyBoundedCandidateBoost, compareByFusedScore, getCandidateFusedScore } from "./candidateScoring.js";

export class MetadataRuleScoringService {
  apply(input: {
    candidates: RetrievedCandidate[];
    metadataRules: RetrievalMetadataRule[];
  }): {
    candidates: RetrievedCandidate[];
    appliedRules: AppliedConstraint[];
  } {
    const appliedRules: AppliedConstraint[] = [];
    let candidates = input.candidates.map((candidate) => ({
      ...candidate,
      attributeMatchScore: candidate.attributeMatchScore ?? 0,
    }));

    for (const rule of input.metadataRules) {
      if (!rule.enabled) {
        continue;
      }

      const matchingCandidates = candidates.map((candidate) => ({
        ...candidate,
        matchesRule: this.matchesRule(candidate, rule),
      }));

      candidates =
        rule.effect === "filter"
          ? matchingCandidates.filter((candidate) => candidate.matchesRule)
          : matchingCandidates;

      const updatedCandidates = candidates.map((candidate) => {
        const workingCandidate = candidate as typeof candidate & { matchesRule?: boolean };
        const matched = workingCandidate.matchesRule === true;

        const boost = matched && rule.effect === "boost" ? RETRIEVAL_BEHAVIOR.metadataBoostWeight : 0;
        const fusedScore = applyBoundedCandidateBoost(getCandidateFusedScore(workingCandidate), boost);
        return {
          ...workingCandidate,
          attributeMatchScore: workingCandidate.attributeMatchScore + (
            boost
          ),
          fusedScore,
          similarity: fusedScore,
        };
      });

      candidates = updatedCandidates.map(({ matchesRule: _matchesRule, ...candidate }) => candidate);

      appliedRules.push(buildAppliedConstraintForRule(rule, "applied"));
    }

    return {
      candidates: candidates.sort(compareByFusedScore),
      appliedRules,
    };
  }

  private matchesRule(candidate: RetrievedCandidate, rule: RetrievalMetadataRule): boolean {
    const conditions = getNormalizedMetadataConditions(rule);
    const matches = conditions.map((condition) => {
      const metadataValue = getValueAtPath(candidate.metadata ?? {}, condition.field);
      return evaluateMetadataRule(metadataValue, condition.valueType, condition.operator, condition.value);
    });

    return (rule.combinator ?? "and") === "or" ? matches.some(Boolean) : matches.every(Boolean);
  }
}

export const buildAppliedConstraintForRule = (
  rule: RetrievalMetadataRule,
  outcome: AppliedConstraint["outcome"],
): AppliedConstraint => ({
  signalKey:
    getNormalizedMetadataConditions(rule).length === 1
      ? `metadata.${getNormalizedMetadataConditions(rule)[0]?.field ?? rule.field}`
      : `metadata.group.${rule.id}`,
  mode: rule.effect === "filter" ? "hard_filter" : "boost_only",
  outcome,
  summary: renderRuleSummary(rule),
});

const renderRuleSummary = (rule: RetrievalMetadataRule): string => {
  const conditions = getNormalizedMetadataConditions(rule);
  const rendered = conditions.map((condition) => `${condition.field} ${renderOperator(condition.operator)} ${condition.value}`);
  if (rendered.length === 1) {
    return rendered[0] ?? "";
  }

  const combinator = (rule.combinator ?? "and").toUpperCase();
  return rendered.map((entry) => `(${entry})`).join(` ${combinator} `);
};

const getValueAtPath = (metadata: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, metadata);

const isScalarMetadataValue = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const normalizeString = (value: string | number | boolean | null): string => String(value).trim().toLowerCase();
const normalizeBoolean = (value: string | boolean): boolean =>
  typeof value === "boolean" ? value : value.trim().toLowerCase() === "true";
const normalizeNumber = (value: string | number): number => (typeof value === "number" ? value : Number(value.trim()));
const normalizeDate = (value: string | number): number =>
  typeof value === "number"
    ? value
    : isDynamicDateToken(String(value))
      ? resolveDynamicDateTokenToEpochMs(String(value))
      : Date.parse(String(value).trim());
const isStringBooleanValue = (value: string | number | boolean | null): value is string | boolean =>
  typeof value === "string" || typeof value === "boolean";
const isStringNumberValue = (value: string | number | boolean | null): value is string | number =>
  typeof value === "string" || typeof value === "number";

const evaluateMetadataRule = (
  candidateValue: unknown,
  valueType: MetadataValueType,
  operator: MetadataRuleOperator,
  ruleValue: string,
): boolean => {
  if (!isScalarMetadataValue(candidateValue)) {
    return false;
  }

  if (valueType === "string") {
    if (operator === "equals") {
      return normalizeString(candidateValue) === normalizeString(ruleValue);
    }
    if (operator === "not_equals") {
      return normalizeString(candidateValue) !== normalizeString(ruleValue);
    }
    if (operator === "contains") {
      return normalizeString(candidateValue).includes(ruleValue.trim().toLowerCase());
    }
    if (operator === "not_contains") {
      return !normalizeString(candidateValue).includes(ruleValue.trim().toLowerCase());
    }
    return false;
  }

  if (valueType === "boolean") {
    if (!isStringBooleanValue(candidateValue)) {
      return false;
    }
    const left = normalizeBoolean(candidateValue);
    const right = normalizeBoolean(ruleValue);
    if (operator === "equals") {
      return left === right;
    }
    if (operator === "not_equals") {
      return left !== right;
    }
    return false;
  }

  if (!isStringNumberValue(candidateValue)) {
    return false;
  }

  const left =
    valueType === "number" ? normalizeNumber(candidateValue) : normalizeDate(candidateValue);
  const right = valueType === "number" ? normalizeNumber(ruleValue) : normalizeDate(ruleValue);

  if (operator === "equals") return left === right;
  if (operator === "not_equals") return left !== right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "contains" || operator === "not_contains") {
    return false;
  }

  return false;
};

const renderOperator = (operator: MetadataRuleOperator): string => {
  if (operator === "not_equals") return "does not equal";
  if (operator === "not_contains") return "does not contain";
  if (operator === "lt") return "<";
  if (operator === "lte") return "<=";
  if (operator === "gt") return ">";
  if (operator === "gte") return ">=";
  return operator;
};
