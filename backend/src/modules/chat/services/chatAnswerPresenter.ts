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

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const hasWordLikeContent = (value: string): boolean => {
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) {
      return true;
    }
  }

  return false;
};

const leadingNonWordText = (value: string): string => {
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) {
      return value.slice(0, segment.index).trimEnd();
    }
  }

  return value;
};

const includesIdentityName = (segment: AnswerSegment, identityName?: string): boolean =>
  Boolean(identityName && segment.text.toLocaleLowerCase().includes(identityName.toLocaleLowerCase()));

const hasMarkdownLink = (segment: AnswerSegment): boolean => /\[[^\]\n]+]\([^)]+\)/.test(segment.text);

const filterUnsupportedGroundedSegments = (
  answerSegments: AnswerSegment[] | undefined,
  identityName?: string,
): AnswerSegment[] | undefined => {
  if (!answerSegments) {
    return undefined;
  }

  const filtered: AnswerSegment[] = [];

  for (const segment of answerSegments) {
    if (
      (segment.citationIndices?.length ?? 0) > 0
      || !hasWordLikeContent(segment.text)
      || includesIdentityName(segment, identityName)
      || hasMarkdownLink(segment)
    ) {
      filtered.push(segment);
      continue;
    }

    const prefix = leadingNonWordText(segment.text);
    if (prefix && filtered.some((candidate) => (candidate.citationIndices?.length ?? 0) > 0)) {
      filtered.push({ text: prefix });
    }
  }

  return filtered;
};

const hasCitedSegment = (answerSegments: AnswerSegment[] | undefined): boolean =>
  answerSegments?.some((segment) => (segment.citationIndices?.length ?? 0) > 0) ?? false;

const hasUnsupportedSubstantiveSegment = (
  answerSegments: AnswerSegment[] | undefined,
  identityName?: string,
): boolean =>
  answerSegments?.some((segment) =>
    (segment.citationIndices?.length ?? 0) === 0
    && hasWordLikeContent(segment.text)
    && !includesIdentityName(segment, identityName)
    && !hasMarkdownLink(segment),
  ) ?? false;

const rebuildAnswerFromSegments = (answerSegments: AnswerSegment[]): string =>
  answerSegments.map((segment) => segment.text).join("").trim();

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

export interface SkillOutcomeCapabilityProvider {
  supportsGroundedAnswer(input: {
    skillName: string;
    outcome: string;
  }): boolean;
}

export interface SkillOutcomeCapabilityRegistry {
  get(name: string): {
    outcomes?: Array<{
      name: string;
      groundedAnswer?: boolean;
    }>;
  } | null;
}

export const createSkillOutcomeCapabilityProvider = (
  registry: SkillOutcomeCapabilityRegistry,
): SkillOutcomeCapabilityProvider => ({
  supportsGroundedAnswer: ({ skillName, outcome }) =>
    registry.get(skillName)
      ?.outcomes
      ?.some((candidate) => candidate.name === outcome && candidate.groundedAnswer === true) ?? false,
});

const hasGroundedSuggestionSupport = (input: {
  skillName: string;
  skillOutcome: string;
  hasRetrievedContext: boolean;
  hasCitedAnswer: boolean;
  skillOutcomeCapabilities: SkillOutcomeCapabilityProvider;
}): boolean => {
  if (!input.hasRetrievedContext || !input.hasCitedAnswer) {
    return false;
  }

  return input.skillOutcomeCapabilities.supportsGroundedAnswer({
    skillName: input.skillName,
    outcome: input.skillOutcome,
  });
};

const toCitationEvidence = (session: PreparedSession): CitationEvidence[] =>
  session.retrieval.contexts.map((context) => {
    const sourceUrl = resolveContextSourceUrl(context.metadata);
    const evidence: CitationEvidence = {
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
    };
    if (sourceUrl) {
      evidence.sourceUrl = sourceUrl;
    }
    return evidence;
  });

const toPlanningCitations = (citationEvidence: CitationEvidence[]): ChatCitation[] =>
  citationEvidence.map((citation) => {
    const planning: ChatCitation = {
      documentId: citation.documentId,
      chunkId: citation.chunkId,
      title: citation.title,
    };
    if (citation.sourceUrl) {
      planning.sourceUrl = citation.sourceUrl;
    }
    return planning;
  });

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
    private readonly skillOutcomeCapabilities: SkillOutcomeCapabilityProvider = {
      supportsGroundedAnswer: () => false,
    },
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
    const identityName = session.retrieval.responseIdentity?.name;
    const answerSegments = hasUnsupportedSubstantiveSegment(citationArtifacts.answerSegments, identityName)
      ? filterUnsupportedGroundedSegments(citationArtifacts.answerSegments, identityName)
      : citationArtifacts.answerSegments;
    const filteredAnswer = answerSegments && hasCitedSegment(answerSegments)
      ? rebuildAnswerFromSegments(answerSegments)
      : presented.answer;

    return withLegacyAnswerOutcome({
      ...presented,
      ...citationArtifacts,
      answer: filteredAnswer,
      answerSegments,
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
        skillOutcomeCapabilities: this.skillOutcomeCapabilities,
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

  presentGroundedMissAnswer(answer: string): ChatPresentedAnswer {
    return this.presentNoContextRefusal(answer, []);
  }
}
