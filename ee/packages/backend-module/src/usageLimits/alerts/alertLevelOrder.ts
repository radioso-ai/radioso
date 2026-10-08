import type { ConversationUsageLevel } from "../conversationUsageLevel.js";

/** `ConversationUsageLevel` minus `"ok"`: the levels a usage alert is ever claimed for. */
export type AlertLevel = Exclude<ConversationUsageLevel, "ok">;

export const ALERT_LEVELS: readonly AlertLevel[] = ["nearing_limit", "limit_reached", "grace_exhausted"];

const RANK: Record<ConversationUsageLevel, number> = {
  ok: 0,
  nearing_limit: 1,
  limit_reached: 2,
  grace_exhausted: 3,
};

export const alertLevelRank = (level: ConversationUsageLevel): number => RANK[level];

/**
 * Every alert level crossed moving upward from `before` to `after`, in ascending order. Empty
 * when the level did not change or moved downward (a release or a refund never alerts). A jump
 * of more than one level — e.g. an account assigned straight to an over-limit profile — claims
 * every level it passed through, not just the final one, so an operator who only watches
 * `nearing_limit` still sees it.
 */
export const levelsCrossedUpward = (
  before: ConversationUsageLevel,
  after: ConversationUsageLevel,
): AlertLevel[] => {
  const beforeRank = alertLevelRank(before);
  const afterRank = alertLevelRank(after);
  return ALERT_LEVELS.filter((level) => {
    const rank = alertLevelRank(level);
    return rank > beforeRank && rank <= afterRank;
  });
};
