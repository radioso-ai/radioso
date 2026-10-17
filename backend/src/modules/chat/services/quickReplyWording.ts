import type { AgentMechanicsReplies } from "../../agents/public.js";
import type { TurnPlanQuickReplyKind } from "./turnPlanService.js";

/** Why the planner's own words were not sent (format checks only; low-cardinality). */
export type PlannerTextRejection = "digit" | "currency" | "link" | "email";

const DIGIT_PATTERN = /\p{Nd}/u;
const CURRENCY_PATTERN = /\p{Sc}/u;
// URI scheme syntax (`scheme://`, and the schemes written without slashes) or a `www.` host.
const LINK_PATTERN = /[a-z][a-z0-9+.-]*:\/\/|\b(?:mailto|tel):|\bwww\./iu;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

/**
 * Format checks on the planner's own quick-reply words: any digit, currency symbol, URL, or
 * email address sends the turn to the composer. They catch prices, numbers, and links the
 * planner was told never to write. They do not catch every invented fact, and they encode no
 * language: an agent's authored mechanics lines are the lane's only guarantee.
 */
export const plannerQuickReplyTextRejection = (text: string): PlannerTextRejection | null => {
  if (DIGIT_PATTERN.test(text)) return "digit";
  if (CURRENCY_PATTERN.test(text)) return "currency";
  if (LINK_PATTERN.test(text)) return "link";
  if (EMAIL_PATTERN.test(text)) return "email";
  return null;
};

const primarySubtag = (tag: string): string => tag.split("-")[0] ?? tag;

/**
 * The agent's authored line for this mechanic in the reply's language, rotated by how many replies
 * the conversation already has, or null when there is none to speak. The lookup is exactly the
 * planner's tag for the reply's language, then its primary subtag, compared case-insensitively.
 * No page, browser, or agent locale takes part, so one portable configuration speaks the same
 * line on every channel.
 */
export const authoredMechanicsLine = (input: {
  replies: AgentMechanicsReplies;
  kind: TurnPlanQuickReplyKind;
  language: string;
  rotation: number;
}): string | null => {
  const byLowerTag = new Map(Object.entries(input.replies).map(([tag, lines]) => [tag.toLowerCase(), lines]));
  for (const candidate of new Set([input.language.toLowerCase(), primarySubtag(input.language).toLowerCase()])) {
    const lines = byLowerTag.get(candidate)?.[input.kind] ?? [];
    if (lines.length > 0) {
      return lines[input.rotation % lines.length] ?? null;
    }
  }
  return null;
};
