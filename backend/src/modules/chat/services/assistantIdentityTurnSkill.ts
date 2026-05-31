import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { assistantIdentityAnswerSkillDefinition } from "../../skills/public.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill } from "./turnOutcome.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
export const ASSISTANT_IDENTITY_OUTCOME_KIND = "assistant_identity";
export const ASSISTANT_IDENTITY_TURN_SKILL = assistantIdentityAnswerSkillDefinition.name;

/** Assistant-identity is an assistant-voice reply about the assistant itself. */
export const ASSISTANT_IDENTITY_REPLY_CONFIG: AssistantReplyConfig = {
  skillName: ASSISTANT_IDENTITY_TURN_SKILL,
  outcomeKind: ASSISTANT_IDENTITY_OUTCOME_KIND,
};

export const buildAssistantIdentityTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, {
    kind: ASSISTANT_IDENTITY_OUTCOME_KIND,
    skillName: ASSISTANT_IDENTITY_TURN_SKILL,
  });

/** Registers the assistant-identity answer as a terminal `TurnSkill`, selected for `ASSISTANT_IDENTITY` turns. */
export const createAssistantIdentityTurnSkill = (composer: AssistantReplyComposer): TurnSkill => ({
  definition: { name: ASSISTANT_IDENTITY_TURN_SKILL, outcomeKinds: [ASSISTANT_IDENTITY_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.ASSISTANT_IDENTITY,
  dispatch: (session) => buildAssistantIdentityTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === ASSISTANT_IDENTITY_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
  },
  streamRender: (ctx: TurnRenderContext) =>
    composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
});
