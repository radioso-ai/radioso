import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { isBlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { FallbackReplyComposer } from "./fallbackReplyComposer.js";
import { buildAssistantReplyPrompt, type AssistantReplyPromptInput } from "./assistantReplyPromptBuilder.js";
import type { TurnStreamResult } from "./turnOutcome.js";
import { presentReplyResponseFormat, readPresentReplyEnvelope } from "./replyBlocks/presentReplyEnvelope.js";
import type { ReplyPresentOffer } from "./replyBlocks/skillResultReplyBlocks.js";
import { StructuredAnswerFieldReader } from "./structuredAnswerFieldReader.js";

/**
 * Writes one capability's reply prompt from the turn the composer reads and, for a reply
 * written from a skill's result, the text that skill returned.
 */
type AssistantReplyPromptBuilder = (turn: AssistantReplyPromptInput, skillFindings?: string) => string;

/**
 * Identity of an assistant-voice (non-retrieval) reply capability, and the prompt it
 * writes from. The skill name and outcome kind tag the presented answer; the outcome
 * kind also seeds the usage attempt keys (`<kind>`, `<kind>_miss`, `stream_<kind>`,
 * `stream_<kind>_miss`).
 */
export interface AssistantReplyConfig {
  skillName: string;
  outcomeKind: string;
  /** The capability's prompt; the direct reply's prompt when absent. */
  buildPrompt?: AssistantReplyPromptBuilder;
}

/**
 * Composes a reply in the assistant's own voice, without retrieval — the shared
 * body behind the direct reply and the reply written from a directive-bound
 * skill's result. On a blank model reply it falls back to a plain no-answer reply
 * rather than borrowing the grounded chain. Only the capability identity and its
 * prompt vary, via {@link AssistantReplyConfig}; generation, streaming, and the
 * blank fallback are identical, so there is one implementation, not one per voice.
 *
 * A caller that offers the `present` head ({@link ReplyPresentOffer}) gets the reply as a
 * structured envelope with that field ahead of `answer`; the text streams from `answer` alone,
 * and the blocks are built from the envelope once it is whole. Without an offer, the request is
 * the plain text generation it always was. A blank reply's fallback never carries blocks.
 */
export class AssistantReplyComposer {
  constructor(
    private readonly support: ChatAnswerSupport,
    private readonly chatGateway: ChatGateway,
    private readonly chatAnswerPresenter: ChatAnswerPresenter,
    private readonly fallbackReplyComposer: FallbackReplyComposer,
    private readonly config: AssistantReplyConfig,
  ) {}

  /** The reply prompt and generation options, with the offer's rules and schema when there is one. */
  private request(session: PreparedSession, query: string, skillFindings: string | undefined, offer: ReplyPresentOffer | null | undefined) {
    const prompt = this.buildPrompt(session, query, skillFindings);
    return offer
      ? { prompt: `${prompt}\n\n${offer.promptSection}`, generation: { responseFormat: presentReplyResponseFormat(offer.schemaExtension) } }
      : { prompt };
  }

  /** Builds the capability's reply prompt (the assistant's own voice, no retrieval). */
  private buildPrompt(session: PreparedSession, query: string, skillFindings: string | undefined): string {
    const buildPrompt = this.config.buildPrompt ?? buildAssistantReplyPrompt;
    return buildPrompt({
      route: session.turnRoute,
      responseIdentity: session.retrieval.responseIdentity,
      history: session.history,
      query,
      framing: session.turnFraming,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      pageContextBlock: this.support.buildContextBlock(session),
      pageContextCondition: this.support.pageContextCondition(session),
      conversationSummary: session.conversationSummary,
      steering: session.directiveSteering?.rules ?? [],
      pendingRoutineStep: session.routineYield?.pendingStep,
    }, skillFindings);
  }

  private presentReply(answer: string): ChatPresentedAnswer {
    return this.chatAnswerPresenter.presentNonRetrievalAnswer(answer, {
      skillName: this.config.skillName,
      outcome: this.config.outcomeKind,
      status: "completed",
    });
  }

  /**
   * Generates the reply in one shot (non-streaming), or `null` when blank.
   * `skillFindings` is the text a bound skill returned, for a capability whose prompt
   * writes the reply from it.
   */
  async tryComposeAnswer(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
    skillFindings?: string,
    offer?: ReplyPresentOffer | null,
  ): Promise<ChatPresentedAnswer | null> {
    let raw: string;
    try {
      raw = await this.chatGateway.answer({
        query,
        history: session.history,
        ...this.request(session, query, skillFindings, offer),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, this.config.outcomeKind),
      });
    } catch (error) {
      if (isBlankChatAnswerError(error)) {
        return null;
      }
      throw error;
    }
    const { answer, extras } = offer ? readPresentReplyEnvelope(raw) : { answer: raw.trim(), extras: undefined };
    if (!answer) {
      return null;
    }
    return this.withBlocks(this.presentReply(answer), offer, extras);
  }

  private withBlocks(
    presentation: ChatPresentedAnswer,
    offer: ReplyPresentOffer | null | undefined,
    extras: Record<string, unknown> | undefined,
  ): ChatPresentedAnswer {
    const replyBlocks = offer?.build(extras);
    return replyBlocks ? { ...presentation, replyBlocks } : presentation;
  }

  async composeAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    skillFindings?: string,
    offer?: ReplyPresentOffer | null,
  ): Promise<ChatPresentedAnswer> {
    const reply = await this.tryComposeAnswer(session, query, accountId, skillFindings, offer);
    if (reply) {
      return reply;
    }
    // Graceful no-answer fallback. A blank reply is near-unreachable, but when it
    // happens we decline gracefully via the shared "couldn't answer" composer
    // rather than failing the turn.
    const miss = await this.fallbackReplyComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      steering: session.directiveSteering?.rules ?? [],
      pendingRoutineStep: session.routineYield?.pendingStep,
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, `${this.config.outcomeKind}_miss`),
    });
    return this.presentReply(miss.text);
  }

  /**
   * Streams the reply token-by-token via the gateway's streaming API. On a blank
   * reply it falls back to a graceful no-answer reply (one chunk). Owns its own
   * presentation and returns it as `finalPresentation`; its question suggestions
   * are already settled on that presentation, so it signals `presentation`-sourced
   * suggestions and the host does not re-expand planned suggestions for it.
   */
  async *streamAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    signal?: AbortSignal,
    skillFindings?: string,
    offer?: ReplyPresentOffer | null,
  ): AsyncGenerator<string, TurnStreamResult> {
    let streamedAnswer = "";
    // With an offer the model writes the envelope; only its `answer` field reaches the visitor.
    const envelope = offer ? new StructuredAnswerFieldReader() : null;
    for await (const chunk of this.chatGateway.streamAnswer({
      query,
      history: session.history,
      ...this.request(session, query, skillFindings, offer),
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, `stream_${this.config.outcomeKind}`),
      signal,
    })) {
      const text = envelope ? envelope.push(chunk) : chunk;
      if (!text) {
        continue;
      }
      streamedAnswer += text;
      yield text;
    }

    const { answer, extras } = envelope ? readPresentReplyEnvelope(envelope.raw) : { answer: streamedAnswer.trim(), extras: undefined };
    if (answer) {
      return {
        finalPresentation: this.withBlocks(this.presentReply(answer), offer, extras),
        suggestions: { mode: "presentation" },
        hasStreamedAnswer: true,
        streamedAnswer,
        deliveryMode: "live",
      };
    }

    // Blank reply: return the settled fallback for committed replay. The provider
    // candidate was empty, so there is no live delta to expose.
    const miss = await this.fallbackReplyComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      steering: session.directiveSteering?.rules ?? [],
      pendingRoutineStep: session.routineYield?.pendingStep,
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, `stream_${this.config.outcomeKind}_miss`),
      signal,
    });
    return {
      finalPresentation: this.presentReply(miss.text),
      suggestions: { mode: "presentation" },
      hasStreamedAnswer: false,
      streamedAnswer,
      deliveryMode: "committed",
    };
  }
}
