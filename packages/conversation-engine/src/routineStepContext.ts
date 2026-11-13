import type { RoutineSkillResult, RoutineStep, SteeringRule, TurnContext } from "@radioso/conversation-contract";

/**
 * Projects a step's `action` into a routine steering rule — the keystone that lets
 * a routine step steer the reply through the same steering set authored Directives
 * use. A step with no action (a bare skill step) projects nothing.
 */
export const projectStep = (step: RoutineStep): SteeringRule[] =>
  step.action
    ? [{
        action: step.action,
        source: "routine",
        lifespan: "response",
        description: `routine step ${step.id}`,
      }]
    : [];

/**
 * A skill step's result as the turn stages it for every later step: its outputs, under the step
 * that ran it, so a presenting step can find its source's records by `metadata.stepId` (#1763).
 */
export const stagedContextForSkillResult = (
  step: RoutineStep,
  result: RoutineSkillResult,
): TurnContext["stagedContext"][number] | null => {
  if (!result.outputs) {
    return null;
  }
  return {
    kind: "skill_result",
    ...(step.skillName ? { source: step.skillName } : {}),
    data: result.outputs,
    metadata: {
      stepId: step.id,
      status: result.status,
      ...(result.metadata ? { skillMetadata: result.metadata } : {}),
    },
  };
};
