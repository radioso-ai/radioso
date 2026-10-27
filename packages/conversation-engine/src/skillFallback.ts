import type { SelectedSkill, SkillDefinition, TurnOutcome } from "@radioso/conversation-contract";

import { findSkill } from "./traceSummaries.js";

/**
 * The selection the engine dispatches in place of a skill that settled without
 * completing, or null when the selection names no eligible fallback. A fallback must
 * be registered, differ from the skill it replaces, and declare no input fields: it
 * runs without the resolution pass, so there is nothing to supply them from. The
 * returned selection names no fallback of its own, so a fallback never chains.
 */
export const fallbackSelectionFor = (
  skills: SkillDefinition[],
  selected: SelectedSkill,
  outcome: TurnOutcome,
): { skill: SkillDefinition; selected: SelectedSkill } | null => {
  const fallbackName = selected.fallbackSkillName;
  if (outcome.outcome.status === "completed" || !fallbackName || fallbackName === selected.skillName) {
    return null;
  }
  const skill = findSkill(skills, fallbackName);
  if (!skill || (skill.inputSchema?.fields.length ?? 0) > 0) {
    return null;
  }
  const failureReason = outcome.outcome.error?.code;
  return {
    skill,
    selected: {
      skillName: fallbackName,
      reason: "fallback",
      metadata: {
        fallbackFor: {
          skillName: selected.skillName,
          outcomeStatus: outcome.outcome.status,
          ...(failureReason ? { failureReason } : {}),
        },
      },
    },
  };
};

/**
 * Outputs of one `skill_dispatch` stage. A skill that did not complete names why through
 * the contract's generic `error.code`; a fallback names the skill it stands in for.
 */
export const dispatchStageOutputs = (input: {
  skillName: string;
  outcome: TurnOutcome;
  guidanceCount: number;
  fallbackFor?: string;
}): Record<string, unknown> => {
  const failureReason = input.outcome.outcome.status === "completed" ? undefined : input.outcome.outcome.error?.code;
  return {
    skillName: input.skillName,
    outcomeStatus: input.outcome.outcome.status,
    guidanceCount: input.guidanceCount,
    ...(failureReason ? { failureReason } : {}),
    ...(input.fallbackFor ? { fallbackFor: input.fallbackFor } : {}),
  };
};
