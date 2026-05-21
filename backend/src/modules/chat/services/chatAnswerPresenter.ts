import { resolveContextSourceUrl } from "../../retrieval/public.js";
import { AnswerPresentationService } from "./answerPresentationService.js";
import type { AnswerSegment, ChatCitation, CitationEvidence } from "../contracts/answerTypes.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import type { AssistantSuggestionExpansionService } from "./assistantSuggestionExpansionService.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import type { ChatActionSuggestionService } from "./actionSuggestions/chatActionSuggestionService.js";
import { resolveSkippedValidationArtifacts } from "./implicitCitationSupport.js";

export interface ChatPresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  planningCitations?: ChatCitation[];
  answerOutcome: AssistantTurnOutcome;
}

const hasGroundedSuggestionSupport = (input: {
  answerOutcome: AssistantTurnOutcome;
  hasRetrievedContext: boolean;
}): boolean => {
  if (!input.hasRetrievedContext) {
    return false;
  }

  return input.answerOutcome === ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS;
};

const toCitationEvidence = (session: PreparedSession): CitationEvidence[] =>
  session.retrieval.contexts.map((context) => ({
    documentId: context.documentId,
    chunkId: context.chunkId,
    title: context.title,
    content: context.content,
    sourceUrl: resolveContextSourceUrl(context.metadata),
  }));

const toPlanningCitations = (citationEvidence: CitationEvidence[]): ChatCitation[] =>
  citationEvidence.map((citation) => ({
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    title: citation.title,
  }));

export class ChatAnswerPresenter {
  private readonly answerPresentationService = new AnswerPresentationService();

  constructor(
    private readonly assistantSuggestionExpansionService: AssistantSuggestionExpansionService,
    private readonly chatActionSuggestionService?: ChatActionSuggestionService,
  ) {}

  presentNonRetrievalAnswer(answer: string): ChatPresentedAnswer {
    const presented = this.answerPresentationService.present({
      answer,
      citations: [],
    });

    return {
      ...presented,
      planningCitations: [],
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
    };
  }

  async presentWithSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<ChatPresentedAnswer> {
    const presentation = await this.presentWithoutSuggestions(session, answer, query, userExpectedLocale);
    const withQuestionSuggestions = await this.applyAssistantSuggestions(session, presentation);
    return await this.applyActionSuggestions(session, withQuestionSuggestions, userExpectedLocale);
  }

  async presentWithoutSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<ChatPresentedAnswer> {
    const citationEvidence = toCitationEvidence(session);

    if (session.retrieval.contexts.length === 0) {
      return this.presentNoContextRefusal(answer, citationEvidence);
    }

    const normalized = this.answerPresentationService.normalize({
      answer,
      citations: citationEvidence,
    });
    const presented = this.answerPresentationService.present({
      answer,
      citations: citationEvidence,
    });
    const citationArtifacts = resolveSkippedValidationArtifacts(presented, normalized, citationEvidence);

    return {
      ...presented,
      ...citationArtifacts,
      planningCitations: toPlanningCitations(normalized.citationEvidence),
      answerOutcome: ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS,
    };
  }

  async applyAssistantSuggestions(
    session: PreparedSession,
    presentation: ChatPresentedAnswer,
  ): Promise<ChatPresentedAnswer> {
    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    const expanded = await this.assistantSuggestionExpansionService.apply({
      query: session.userMessage.content,
      suggestedQuestionsEnabled: session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true,
      suggestedQuestionsCount: DEFAULT_SUGGESTED_QUESTIONS_COUNT,
      groundedAnswerSupported: hasGroundedSuggestionSupport({
        answerOutcome: presentation.answerOutcome,
        hasRetrievedContext: session.retrieval.contexts.length > 0,
      }),
      answer: presentation.answer,
      citations: presentation.citations,
      contexts: session.retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
      })),
      history: session.history,
      conversationIntentSnapshot,
    });

    return {
      ...presentation,
      suggestions: expanded.suggestions,
    };
  }

  async applyActionSuggestions(
    session: PreparedSession,
    presentation: ChatPresentedAnswer,
    userExpectedLocale?: string | null,
  ): Promise<ChatPresentedAnswer> {
    if (!this.chatActionSuggestionService) {
      return presentation;
    }
    const actionSuggestions = await this.chatActionSuggestionService.evaluate({
      workspaceId: session.conversation.workspaceId,
      conversationId: session.conversation.id,
      agentId: session.agent.id,
      query: session.userMessage.content,
      answer: presentation.answer,
      answerOutcome: presentation.answerOutcome,
      history: session.history,
      userExpectedLocale: userExpectedLocale ?? undefined,
      sourceChannel: session.conversation.sourceChannel,
      sourceOrigin: session.conversation.sourceOrigin,
    });
    if (actionSuggestions.length === 0) {
      return presentation;
    }
    return {
      ...presentation,
      suggestions: [...actionSuggestions, ...(presentation.suggestions ?? [])],
    };
  }

  private presentNoContextRefusal(
    answer: string,
    citationEvidence: CitationEvidence[],
  ): ChatPresentedAnswer {
    const presented = this.answerPresentationService.present({
      answer,
      citations: citationEvidence,
    });

    return {
      ...presented,
      suggestions: undefined,
      planningCitations: [],
      answerOutcome: ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
    };
  }
}
