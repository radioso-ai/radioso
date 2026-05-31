import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { isBlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";
import { buildNonRetrievalAnswerPrompt } from "./nonRetrievalAnswerPromptBuilder.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { assistantIdentityAnswerSkillDefinition } from "../../skills/public.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill, TurnStreamResult } from "./turnOutcome.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
export const ASSISTANT_IDENTITY_OUTCOME_KIND = "assistant_identity";
export const ASSISTANT_IDENTITY_TURN_SKILL = assistantIdentityAnswerSkillDefinition.name;

export const buildAssistantIdentityTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, {
    kind: ASSISTANT_IDENTITY_OUTCOME_KIND,
    skillName: ASSISTANT_IDENTITY_TURN_SKILL,
  });

/**
 * Composes a reply about the assistant itself — who it is, what it can do — from its
 * configured identity and scope, without retrieval. Standalone: on a blank model
 * reply it falls back to a plain no-answer reply rather than borrowing the grounded
 * chain.
 */
export class AssistantIdentityAnswerComposer {
  constructor(
    private readonly support: ChatAnswerSupport,
    private readonly chatGateway: ChatGateway,
    private readonly chatAnswerPresenter: ChatAnswerPresenter,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer,
  ) {}

  /** Builds the identity reply prompt (the assistant's own voice, no retrieval). */
  private buildPrompt(session: PreparedSession, query: string): string {
    return buildNonRetrievalAnswerPrompt({
      route: session.turnRoute,
      responseIdentity: session.retrieval.responseIdentity,
      history: session.history,
      query,
      intentTopic: session.retrieval.diagnostics.rewriteProposal?.intentTopic,
      inScopeRequest: session.retrieval.diagnostics.rewriteProposal?.inScopeRequest,
      outsideScopeRequest: session.retrieval.diagnostics.rewriteProposal?.outsideScopeRequest,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      pageContextBlock: this.support.buildPageContextBlock(session.pageContext),
    });
  }

  private presentReply(answer: string): ChatPresentedAnswer {
    return this.chatAnswerPresenter.presentNonRetrievalAnswer(answer, {
      skillName: ASSISTANT_IDENTITY_TURN_SKILL,
      outcome: ASSISTANT_IDENTITY_OUTCOME_KIND,
      status: "completed",
    });
  }

  /** Generates the reply in one shot (non-streaming), or `null` when blank. */
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
        prompt: this.buildPrompt(session, query),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "assistant_identity"),
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
    return this.presentReply(answer);
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
    // Graceful no-answer fallback. A blank identity reply is near-unreachable, but
    // when it happens we decline gracefully via the shared "couldn't answer"
    // composer rather than failing the turn.
    const miss = await this.groundedMissResponseComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, "assistant_identity_miss"),
    });
    return this.chatAnswerPresenter.presentGroundedMissAnswer(miss);
  }

  /**
   * Streams the identity reply token-by-token via the gateway's streaming API. On a
   * blank reply it falls back to a graceful no-answer reply (one chunk). Returns the
   * reply as the no-context presentation so the host finalizes it as a non-grounded
   * turn.
   */
  async *streamAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
  ): AsyncGenerator<string, TurnStreamResult> {
    let streamedAnswer = "";
    for await (const text of this.chatGateway.streamAnswer({
      query,
      history: session.history,
      prompt: this.buildPrompt(session, query),
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, "stream_assistant_identity"),
    })) {
      if (!text) {
        continue;
      }
      streamedAnswer += text;
      yield text;
    }

    const answer = streamedAnswer.trim();
    if (answer) {
      return {
        rawAnswer: answer,
        plannedSuggestions: [],
        answerGrounding: "grounded",
        noContextPresentation: this.presentReply(answer),
        hasStreamedAnswer: true,
        streamedAnswer,
      };
    }

    // Blank reply: graceful no-answer fallback, emitted as a single chunk.
    const miss = await this.groundedMissResponseComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, "stream_assistant_identity_miss"),
    });
    yield miss;
    return {
      rawAnswer: miss,
      plannedSuggestions: [],
      answerGrounding: "grounded",
      noContextPresentation: this.chatAnswerPresenter.presentGroundedMissAnswer(miss),
      hasStreamedAnswer: true,
      streamedAnswer: streamedAnswer + miss,
    };
  }
}

/** Registers the assistant-identity answer as a terminal `TurnSkill`, selected for `ASSISTANT_IDENTITY` turns. */
export const createAssistantIdentityTurnSkill = (composer: AssistantIdentityAnswerComposer): TurnSkill => ({
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
