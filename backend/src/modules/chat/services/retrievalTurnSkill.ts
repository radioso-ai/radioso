import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { BlankChatAnswerError, hasCitedAnswerSegment, isBlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import {
  GroundedAnswerEnvelopeReader,
  parseGroundedAnswerEnvelope,
  type AnswerGroundingVerdict,
  type GroundedAnswerEnvelope,
  type PlannedEnvelopeSuggestion,
} from "./groundedAnswerEnvelope.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";
import { composeGroundedAnswerSystemPrompt } from "./groundedAnswerPromptComposer.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import { retrievalAnswerSkillDefinition } from "../../skills/public.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill, TurnStreamResult } from "./turnOutcome.js";

/** The outcome kind a grounded/retrieval turn produces (chat-side renderer tag). */
export const RETRIEVAL_OUTCOME_KIND = "retrieval";

// Structural matcher for a leading run of citation anchors (`[[n]]`) plus trailing
// punctuation/space — used to detect when grounded prose is anchored enough to
// start streaming. Format syntax, not product vocabulary.
const CITED_ANSWER_PREFIX_PATTERN = /\[\[\d+\]\](?:[ \t]*[.,;:!?)]?)?[ \t]*/g;

const splitCitedAnswerPrefix = (buffer: string): { streamable: string; remaining: string } => {
  let releaseEnd = 0;
  for (const match of buffer.matchAll(CITED_ANSWER_PREFIX_PATTERN)) {
    releaseEnd = match.index + match[0].length;
  }
  return {
    streamable: buffer.slice(0, releaseEnd),
    remaining: buffer.slice(releaseEnd),
  };
};

/** The skill this turn dispatches — identity sourced from the canonical skill catalog. */
export const RETRIEVAL_TURN_SKILL = retrievalAnswerSkillDefinition.name;

export const buildRetrievalTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: RETRIEVAL_OUTCOME_KIND, skillName: RETRIEVAL_TURN_SKILL });

/**
 * Composes a grounded answer for a retrieval turn: the grounded system prompt, the
 * envelope call, the page-context fallback, and the grounded-miss replacement when
 * the model fails to cite. Grounding is retrieval's *private* business — this only
 * ever runs for `RETRIEVAL` turns; social/identity turns are answered by their own
 * skills and never reach here.
 */
export class RetrievalAnswerComposer {
  constructor(
    private readonly support: ChatAnswerSupport,
    private readonly chatGateway: ChatGateway,
    private readonly chatAnswerPresenter: ChatAnswerPresenter,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer,
  ) {}

  composeGroundedSystemPrompt(session: PreparedSession): string {
    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    return composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: session.retrieval.systemPrompt,
      suggestedQuestionsEnabled: session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true,
      suggestedQuestionsCount:
        session.retrieval.responseSettings?.suggestedQuestionsCount ?? DEFAULT_SUGGESTED_QUESTIONS_COUNT,
      hasRetrievedContexts: session.retrieval.contexts.length > 0,
      conversationIntentSnapshot,
      steering: session.directiveSteering?.rules ?? [],
    }).systemPrompt;
  }

  private async generateGroundedAnswerEnvelope(
    session: PreparedSession,
    query: string,
    prompt: string,
    accountId: string | undefined,
    attemptKey: string,
  ): Promise<GroundedAnswerEnvelope> {
    const raw = await this.chatGateway.answer({
      query,
      history: session.history,
      systemPrompt: this.composeGroundedSystemPrompt(session),
      prompt,
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, attemptKey),
    });
    const envelope = parseGroundedAnswerEnvelope(raw);
    if (!envelope.answer.trim()) {
      throw new BlankChatAnswerError();
    }
    return envelope;
  }

  async generateAnswerWithPageContext(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
  ): Promise<GroundedAnswerEnvelope | null> {
    const prompt = this.support.buildPromptWithPageContext(session.retrieval.prompt, session.pageContext);
    if (prompt === session.retrieval.prompt) {
      return null;
    }

    try {
      const envelope = await this.generateGroundedAnswerEnvelope(session, query, prompt, accountId, "page_context");
      return { ...envelope, answer: envelope.answer.trim() };
    } catch (error) {
      // Page-context fallback is best-effort — let blank envelopes drop through.
      if (isBlankChatAnswerError(error)) {
        return null;
      }
      throw error;
    }
  }

  async composeAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
  ): Promise<ChatPresentedAnswer> {
    let answer: string;
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let answerGrounding: AnswerGroundingVerdict = "grounded";

    if (session.retrieval.contexts.length === 0) {
      const fallback = await this.generateAnswerWithPageContext(session, query, accountId);
      if (fallback) {
        answer = fallback.answer;
        plannedSuggestions = fallback.suggestions;
      } else {
        answer = await this.groundedMissResponseComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "grounded_miss"),
        });
      }
    } else {
      const envelope = await this.generateGroundedAnswerEnvelope(
        session,
        query,
        this.support.buildPromptWithPageContext(session.retrieval.prompt, session.pageContext),
        accountId,
        "grounded",
      );
      answer = envelope.answer;
      plannedSuggestions = envelope.suggestions;
      answerGrounding = envelope.grounding;
    }

    const presentation = await this.chatAnswerPresenter.presentWithSuggestions(
      session,
      answer,
      query,
      plannedSuggestions,
      userExpectedLocale,
      answerGrounding,
    );
    if (session.retrieval.contexts.length > 0 && !hasCitedAnswerSegment(presentation)) {
      const groundedMiss = await this.groundedMissResponseComposer.composeNoContext({
        query,
        userExpectedLocale,
        answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "grounded_unsupported"),
      });
      return this.chatAnswerPresenter.presentGroundedMissAnswer(groundedMiss);
    }

    return presentation;
  }

  /**
   * Streams the grounded answer: a no-context fallback yielded as one chunk, or the
   * token loop that holds un-cited prose until the first citation anchor confirms
   * grounding, then streams every later token. Yields chunk text; returns the raw
   * result for the host to finalize (present / grounded-miss reconcile / persist).
   */
  async *streamAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
  ): AsyncGenerator<string, TurnStreamResult> {
    let rawAnswer = "";
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let answerGrounding: AnswerGroundingVerdict = "grounded";
    let hasStreamedAnswer = false;
    let streamedAnswer = "";

    if (session.retrieval.contexts.length === 0) {
      const fallbackEnvelope = await this.generateAnswerWithPageContext(session, query, accountId);
      rawAnswer = fallbackEnvelope?.answer
        ?? await this.groundedMissResponseComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded_miss"),
        });
      yield rawAnswer;
      hasStreamedAnswer = true;
      streamedAnswer += rawAnswer;
    } else {
      const reader = new GroundedAnswerEnvelopeReader();
      const citationSanitizer = new CitationAnchorSanitizer();
      let pendingStreamText = "";
      let groundingConfirmed = false;
      for await (const text of this.chatGateway.streamAnswer({
        query,
        history: session.history,
        systemPrompt: this.composeGroundedSystemPrompt(session),
        prompt: this.support.buildPromptWithPageContext(session.retrieval.prompt, session.pageContext),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded"),
      })) {
        if (!text) {
          continue;
        }
        pendingStreamText += reader.push(text);
        if (!groundingConfirmed && splitCitedAnswerPrefix(pendingStreamText).streamable) {
          groundingConfirmed = true;
        }
        let streamable = "";
        if (groundingConfirmed) {
          streamable = pendingStreamText;
          pendingStreamText = "";
        }
        const cleanChunk = citationSanitizer.push(streamable);
        if (cleanChunk) {
          streamedAnswer += cleanChunk;
          yield cleanChunk;
          hasStreamedAnswer = true;
        }
      }

      const finalized = reader.finalize();
      plannedSuggestions = finalized.suggestions;
      answerGrounding = finalized.grounding;
      rawAnswer = finalized.fullAnswer;
      if (!rawAnswer.trim()) {
        throw new BlankChatAnswerError();
      }
    }

    return {
      rawAnswer,
      plannedSuggestions,
      answerGrounding,
      noContextPresentation: null,
      hasStreamedAnswer,
      streamedAnswer,
    };
  }
}

/**
 * Registers retrieval as a terminal `TurnSkill`. It `selects` only `RETRIEVAL`
 * turns and renders through its own `RetrievalAnswerComposer`. The generic turn
 * machinery never references it.
 */
export const createRetrievalTurnSkill = (composer: RetrievalAnswerComposer): TurnSkill => ({
  definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.RETRIEVAL,
  dispatch: (session) => buildRetrievalTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
  },
  streamRender: (ctx: TurnRenderContext) =>
    composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
});
