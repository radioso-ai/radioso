import { answerCoverageCriteriaMatches } from "@radioso/conversation-defaults";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import type { AnswerCoverageAssessment } from "../contracts/answerCoverage.js";

/**
 * Rewrites coverage-gated steering rules for a prompt composed AFTER the
 * verdict is already known (#1260 review F2): the zero-evidence decline, the
 * grounding-gate-bound decline, and the unsupported-draft decline all compose
 * through a model that is never asked to emit a `coverage` field, so the
 * conditional phrasing `renderSteeringRules` produces for a rule still tagged
 * with `coverageCriteria` ("Only when your coverage verdict is one of [...]")
 * is a condition that model can never evaluate. Once the verdict is already
 * known, a matching rule renders as a plain, unconditional instruction and a
 * non-matching one is dropped rather than rendered as an unresolvable
 * condition. Rules without `coverageCriteria` pass through unchanged.
 */
export const steeringRulesForKnownVerdict = (
  rules: readonly SteeringRule[],
  assessment: AnswerCoverageAssessment,
): SteeringRule[] =>
  rules.flatMap((rule) => {
    if (!rule.coverageCriteria) {
      return [rule];
    }
    if (assessment.availability !== "assessed") {
      return [];
    }
    if (!answerCoverageCriteriaMatches(rule.coverageCriteria, assessment)) {
      return [];
    }
    const { coverageCriteria: _coverageCriteria, ...plainRule } = rule;
    return [plainRule];
  });
