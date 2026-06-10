import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { directAnswerSkillDefinition } from "../../skills/public.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill } from "./turnOutcome.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
export const DIRECT_OUTCOME_KIND = "direct";
export const DIRECT_TURN_SKILL = directAnswerSkillDefinition.name;

/** Direct is an assistant-voice reply without retrieval. */
export const DIRECT_REPLY_CONFIG: AssistantReplyConfig = {
  skillName: DIRECT_TURN_SKILL,
  outcomeKind: DIRECT_OUTCOME_KIND,
};

export const buildDirectTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: DIRECT_OUTCOME_KIND, skillName: DIRECT_TURN_SKILL });

/** Registers the direct answer as a terminal `TurnSkill`, selected for direct turns. */
export const createDirectTurnSkill = (composer: AssistantReplyComposer): TurnSkill => ({
  definition: { name: DIRECT_TURN_SKILL, outcomeKinds: [DIRECT_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.DIRECT,
  dispatch: (session) => buildDirectTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === DIRECT_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
  },
  streamRender: (ctx: TurnRenderContext) =>
    composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
});
