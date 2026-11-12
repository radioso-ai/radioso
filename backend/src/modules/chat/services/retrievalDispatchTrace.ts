import type { ConversationTrace } from "@radioso/conversation-contract";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRetrievalSkillName = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("retrieval.");

/** Whether the turn dispatched a retrieval skill, directly or from a routine step. */
export const traceIncludesRetrievalSkillDispatch = (trace?: ConversationTrace): boolean =>
  trace?.stages.some((stage) => {
    if (isRetrievalSkillName(stage.outputs?.skillName)) {
      return true;
    }

    if (stage.subTrace?.namespace !== "routine" || !isRecord(stage.subTrace.payload)) {
      return false;
    }

    const steps = stage.subTrace.payload.steps;
    return Array.isArray(steps) && steps.some((step) =>
      isRecord(step)
      && step.event === "skill_dispatched"
      && isRetrievalSkillName(step.skillName),
    );
  }) ?? false;
