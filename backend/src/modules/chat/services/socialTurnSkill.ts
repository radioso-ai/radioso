import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { isBlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";
import { buildNonRetrievalAnswerPrompt } from "./nonRetrievalAnswerPromptBuilder.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { socialAnswerSkillDefinition } from "../../skills/public.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill } from "./turnOutcome.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
export const SOCIAL_OUTCOME_KIND = "social_only";
export const SOCIAL_TURN_SKILL = socialAnswerSkillDefinition.name;

export const buildSocialTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: SOCIAL_OUTCOME_KIND, skillName: SOCIAL_TURN_SKILL });

/**
 * Composes a social-only reply — acknowledgement, politeness, small talk — in the
 * assistant's own voice, without retrieval. Standalone: on a blank model reply it
 * falls back to a plain no-answer reply rather than borrowing the grounded chain.
 */
export class SocialAnswerComposer {
  constructor(
    private readonly support: ChatAnswerSupport,
    private readonly chatGateway: ChatGateway,
    private readonly chatAnswerPresenter: ChatAnswerPresenter,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer,
  ) {}

  /** Generates the reply, or `null` when the model returns a blank answer. */
  async tryComposeAnswer(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
  ): Promise<ChatPresentedAnswer | null> {
    let answer: string;
    try {
      answer = (await this.chatGateway.answer({
        query,
        history: session.history,
        prompt: buildNonRetrievalAnswerPrompt({
          route: session.turnRoute,
          responseIdentity: session.retrieval.responseIdentity,
          history: session.history,
          query,
          intentTopic: session.retrieval.diagnostics.rewriteProposal?.intentTopic,
          inScopeRequest: session.retrieval.diagnostics.rewriteProposal?.inScopeRequest,
          outsideScopeRequest: session.retrieval.diagnostics.rewriteProposal?.outsideScopeRequest,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          pageContextBlock: this.support.buildPageContextBlock(session.pageContext),
        }),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "social_only"),
      })).trim();
    } catch (error) {
      if (isBlankChatAnswerError(error)) {
        return null;
      }
      throw error;
    }
    if (!answer) {
      return null;
    }
    return this.chatAnswerPresenter.presentNonRetrievalAnswer(answer);
  }

  async composeAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
  ): Promise<ChatPresentedAnswer> {
    const reply = await this.tryComposeAnswer(session, query, accountId);
    if (reply) {
      return reply;
    }
    // Graceful no-answer fallback. A blank social reply is near-unreachable, but
    // when it happens we decline gracefully via the shared "couldn't answer"
    // composer rather than failing the turn.
    const miss = await this.groundedMissResponseComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, "social_only_miss"),
    });
    return this.chatAnswerPresenter.presentGroundedMissAnswer(miss);
  }
}

/** Registers the social-only answer as a terminal `TurnSkill`, selected for `SOCIAL_ONLY` turns. */
export const createSocialTurnSkill = (composer: SocialAnswerComposer): TurnSkill => ({
  definition: { name: SOCIAL_TURN_SKILL, outcomeKinds: [SOCIAL_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.SOCIAL_ONLY,
  dispatch: (session) => buildSocialTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === SOCIAL_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
  },
});
