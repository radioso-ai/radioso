import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { socialAnswerSkillDefinition } from "../../skills/public.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill } from "./turnOutcome.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
export const SOCIAL_OUTCOME_KIND = "social_only";
export const SOCIAL_TURN_SKILL = socialAnswerSkillDefinition.name;

/** Social-only is an assistant-voice reply — acknowledgement, politeness, small talk. */
export const SOCIAL_REPLY_CONFIG: AssistantReplyConfig = {
  skillName: SOCIAL_TURN_SKILL,
  outcomeKind: SOCIAL_OUTCOME_KIND,
};

export const buildSocialTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: SOCIAL_OUTCOME_KIND, skillName: SOCIAL_TURN_SKILL });

/** Registers the social-only answer as a terminal `TurnSkill`, selected for `SOCIAL_ONLY` turns. */
export const createSocialTurnSkill = (composer: AssistantReplyComposer): TurnSkill => ({
  definition: { name: SOCIAL_TURN_SKILL, outcomeKinds: [SOCIAL_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.SOCIAL_ONLY,
  dispatch: (session) => buildSocialTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === SOCIAL_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
  },
  streamRender: (ctx: TurnRenderContext) =>
    composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
});
