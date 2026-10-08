import type { SkillExecution } from "../../skills/public.js";

import { RETRIEVAL_ANSWER_ADAPTER } from "./retrievalAnswerSkillExecutor.js";

/**
 * Whether running a skill may act outside the conversation: send an email, call a webhook,
 * post to Slack, notify operators, or call an external tool. The one skill known to stay
 * inside it is a retrieval skill reading workspace evidence through the internal retrieval
 * adapter; every other skill, and any execution not recognised here, may act outside it.
 *
 * `retrieval` says the skill belongs to retrieval — an agent's `retrieve` skill, or a
 * platform retrieval skill such as `retrieval.context` — so a skill of another kind that is
 * configured onto the retrieval adapter still counts as acting outside the conversation.
 * Safe-test turns suppress exactly the skills this returns true for, and live chat saves a
 * routine turn before showing its reply when one of them ran, so the two never disagree.
 */
export const skillActsOutsideConversation = (skill: {
  retrieval: boolean;
  execution: SkillExecution | undefined;
}): boolean =>
  !(
    skill.retrieval
    && skill.execution?.kind === "internal"
    && skill.execution.adapter === RETRIEVAL_ANSWER_ADAPTER
  );
