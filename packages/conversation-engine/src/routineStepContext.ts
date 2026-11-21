import type {
  RoutineSkillResult,
  RoutineStep,
  RoutineStepSkillResult,
  SkillOutputContract,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

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
 * that ran it, so a presenting step can find its source's records by `metadata.stepId` (#1763),
 * with the typed contract they follow when the skill declares one.
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
      ...(result.outputContract ? { outputContract: result.outputContract } : {}),
      ...(result.metadata ? { skillMetadata: result.metadata } : {}),
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A result {@link stagedContextForSkillResult} staged with a contract, by the step that ran it; null for anything else. */
const contractResultOf = (staged: TurnContext["stagedContext"][number]): { stepId: string; result: RoutineStepSkillResult } | null => {
  const { metadata, data, source } = staged;
  if (
    staged.kind !== "skill_result" || !source || !isRecord(data) || !isRecord(metadata) ||
    typeof metadata.stepId !== "string" || typeof metadata.status !== "string" || !isRecord(metadata.outputContract)
  ) {
    return null;
  }
  const outputContract = metadata.outputContract as SkillOutputContract;
  // Only what the contract declares: a value the skill returned beside it never reaches a reply.
  const outputs = Object.fromEntries(Object.entries(data).filter(([name]) => Object.hasOwn(outputContract, name)));
  return { stepId: metadata.stepId, result: { skillName: source, status: metadata.status, outputs, outputContract } };
};

/**
 * What this turn's tool steps returned, for the reply of a step after them (#1883), read from what
 * the walk staged: one result per step, the latest when a step ran twice, in the order the steps
 * last ran, and only a result whose skill declares an output contract, with only the outputs it
 * declares. A result without a contract (an MCP tool) is left out, as before. The size is the
 * executor's to bound, as for the next-step selector that reads the same result.
 */
export const turnSkillResults = (stagedContext: TurnContext["stagedContext"]): RoutineStepSkillResult[] => {
  const byStep = new Map<string, RoutineStepSkillResult>();
  for (const staged of stagedContext) {
    const found = contractResultOf(staged);
    if (found) {
      byStep.delete(found.stepId);
      byStep.set(found.stepId, found.result);
    }
  }
  return [...byStep.values()];
};
