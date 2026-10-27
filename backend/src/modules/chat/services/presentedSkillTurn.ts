import type { SkillTurnOutcome } from "./assistantTurnOutcomeTypes.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";

/**
 * The skill outcome a turn records for its reply. When a directive-bound skill failed and
 * another skill wrote the reply in its place, the turn records the bound skill's failure,
 * the same row a failed bound skill always wrote, so Quality's skill-failure signal and
 * every other reader of the skill columns still see it. The skill that answered rides
 * alongside as `fallback`.
 */
export const presentedSkillTurnOutcome = (presentation: ChatPresentedAnswer): SkillTurnOutcome => {
  const failed = presentation.fallbackFor;
  if (!failed) {
    return {
      skillName: presentation.skillName,
      outcome: presentation.skillOutcome,
      status: presentation.skillStatus,
    };
  }
  return {
    skillName: failed.skillName,
    outcome: failed.outcomeStatus,
    status: failed.outcomeStatus,
    fallback: {
      skillName: presentation.skillName,
      ...(failed.failureReason ? { failureReason: failed.failureReason } : {}),
    },
  };
};
