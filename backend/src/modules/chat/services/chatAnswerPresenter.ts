import { resolveContextSourceUrl } from "../../retrieval/public.js";
import { AnswerPresentationService } from "./answerPresentationService.js";
import type { AnswerSegment, ChatCitation, CitationEvidence } from "../contracts/answerTypes.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
  SKILL_TURN_OUTCOME,
  type SkillTurnOutcome,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import type { AssistantSuggestionExpansionService } from "./assistantSuggestionExpansionService.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import type { ChatActionSuggestionService } from "./actionSuggestions/chatActionSuggestionService.js";
import type { PlannedEnvelopeSuggestion } from "./groundedAnswerEnvelope.js";
import { resolveCitationArtifacts } from "./implicitCitationSupport.js";

export interface ChatPresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  planningCitations?: ChatCitation[];
  skillName: string;
  skillOutcome: string;
  skillStatus: SkillTurnOutcome["status"];
  answerOutcome?: AssistantTurnOutcome;
}

const hasGroundedSuggestionSupport = (input: {
  skillName: string;
  skillOutcome: string;
  hasRetrievedContext: boolean;
  hasCitedAnswer: boolean;
}): boolean => {
  if (!input.hasRetrievedContext || !input.hasCitedAnswer) {
    return false;
  }

  return input.skillName === SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.skillName
    && input.skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.outcome;
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

const withLegacyAnswerOutcome = <T extends Omit<ChatPresentedAnswer, "answerOutcome">>(
  presentation: T,
): ChatPresentedAnswer => ({
  ...presentation,
  answerOutcome: legacyAnswerOutcomeForSkillTurnOutcome({
    skillName: presentation.skillName,
    outcome: presentation.skillOutcome,
    status: presentation.skillStatus,
  }),
});

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
      skillName: SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL.skillName,
      skillOutcome: SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL.outcome,
      skillStatus: SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL.status,
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
    };
  }

  async presentWithSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    plannedSuggestions: PlannedEnvelopeSuggestion[],
    userExpectedLocale?: string | null,
  ): Promise<ChatPresentedAnswer> {
    const presentation = await this.presentWithoutSuggestions(session, answer, query, userExpectedLocale);
    const withQuestionSuggestions = this.applyAssistantSuggestions(session, presentation, plannedSuggestions);
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
    const citationArtifacts = resolveCitationArtifacts(presented, normalized, citationEvidence);

    return withLegacyAnswerOutcome({
      ...presented,
      ...citationArtifacts,
      planningCitations: toPlanningCitations(normalized.citationEvidence),
      skillName: SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.skillName,
      skillOutcome: SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.outcome,
      skillStatus: SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.status,
    });
  }

  applyAssistantSuggestions(
    session: PreparedSession,
    presentation: ChatPresentedAnswer,
    plannedSuggestions: PlannedEnvelopeSuggestion[],
  ): ChatPresentedAnswer {
    const expanded = this.assistantSuggestionExpansionService.apply({
      query: session.userMessage.content,
      suggestedQuestionsEnabled: session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true,
      suggestedQuestionsCount:
        session.retrieval.responseSettings?.suggestedQuestionsCount ?? DEFAULT_SUGGESTED_QUESTIONS_COUNT,
      groundedAnswerSupported: hasGroundedSuggestionSupport({
        skillName: presentation.skillName,
        skillOutcome: presentation.skillOutcome,
        hasRetrievedContext: session.retrieval.contexts.length > 0,
        hasCitedAnswer: Boolean(
          (presentation.citations?.length ?? 0) > 0
          && presentation.answerSegments?.some((segment) => (segment.citationIndices?.length ?? 0) > 0),
        ),
      }),
      answer: presentation.answer,
      contexts: session.retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
      })),
      plannedSuggestions,
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
      skillName: presentation.skillName,
      skillOutcome: presentation.skillOutcome,
      skillStatus: presentation.skillStatus,
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

    return withLegacyAnswerOutcome({
      ...presented,
      suggestions: undefined,
      planningCitations: [],
      skillName: SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.skillName,
      skillOutcome: SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome,
      skillStatus: SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.status,
    });
  }
}
