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
import type { AnswerGroundingVerdict, PlannedEnvelopeSuggestion } from "./groundedAnswerEnvelope.js";
import { resolveCitationArtifacts } from "./implicitCitationSupport.js";

export interface ChatPresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  planningCitations?: ChatCitation[];
  // Internal handoff for answers rendered from a retrieval result that was
  // recovered outside the original prepared session, such as routine steps.
  effectiveRetrieval?: PreparedSession["retrieval"];
  skillName: string;
  skillOutcome: string;
  skillStatus: SkillTurnOutcome["status"];
  answerOutcome?: AssistantTurnOutcome;
  // The model's raw self-reported grounding verdict for this turn, retained for
  // observability/eval even when the grounded-miss safety net later reclassifies
  // the turn (e.g. a degraded draft with no citations becomes no_context).
  grounding?: AnswerGroundingVerdict;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

// Map the engine's host-neutral `ConversationCitation[]` (carried on a routine reply's
// `RenderableTurn.citations`) into the same `CitationEvidence` shape the grounded path
// uses, resolving + validating the source URL from the passed-through context metadata.
// Junk entries are dropped — the field is typed `unknown[]` at the contract boundary.
const toRoutineCitationEvidence = (citations: readonly unknown[] | undefined): CitationEvidence[] => {
  if (!Array.isArray(citations)) {
    return [];
  }
  const evidence: CitationEvidence[] = [];
  for (const candidate of citations) {
    if (!isRecord(candidate)) {
      continue;
    }
    const title = optionalText(candidate.title);
    const content = optionalText(candidate.content);
    if (!title && !content) {
      continue;
    }
    const item: CitationEvidence = {
      documentId: optionalText(candidate.documentId) ?? "",
      chunkId: optionalText(candidate.chunkId) ?? "",
      title: title ?? "Source",
      content: content ?? "",
    };
    const sourceUrl = resolveContextSourceUrl(isRecord(candidate.metadata) ? candidate.metadata : undefined);
    if (sourceUrl) {
      item.sourceUrl = sourceUrl;
    }
    evidence.push(item);
  }
  return evidence;
};

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

  presentNonRetrievalAnswer(
    answer: string,
    skillTurnOutcome: SkillTurnOutcome = SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL,
  ): ChatPresentedAnswer {
    const presented = this.answerPresentationService.present({
      answer,
      citations: [],
    });

    // The non-retrieval answer skills (social / identity) pass their own identity so
    // the persisted turn reflects the capability that handled it; the legacy
    // answer_outcome stays the coarse non-retrieval value.
    return {
      ...presented,
      planningCitations: [],
      skillName: skillTurnOutcome.skillName,
      skillOutcome: skillTurnOutcome.outcome,
      skillStatus: skillTurnOutcome.status,
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
    };
  }

  /**
   * Presents a routine step reply, attaching citations when the step grounded its answer
   * on a `retrieval.context` skill step (the engine carries them on `RenderableTurn.citations`).
   * With no citations it behaves exactly like {@link presentNonRetrievalAnswer}, so steps that
   * don't ground stay uncited. Per-agent `citationDisplayEnabled` still gates public exposure
   * downstream; this only attaches the artifacts.
   */
  presentRoutineAnswer(
    answer: string,
    citations?: readonly unknown[],
    skillTurnOutcome: SkillTurnOutcome = SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL,
  ): ChatPresentedAnswer {
    const citationEvidence = toRoutineCitationEvidence(citations);
    if (citationEvidence.length === 0) {
      return this.presentNonRetrievalAnswer(answer, skillTurnOutcome);
    }

    const normalized = this.answerPresentationService.normalize({ answer, citations: citationEvidence });
    const presented = this.answerPresentationService.present({ answer, citations: citationEvidence });
    const citationArtifacts = resolveCitationArtifacts(presented, normalized, citationEvidence);

    return {
      ...presented,
      ...citationArtifacts,
      planningCitations: toPlanningCitations(normalized.citationEvidence),
      skillName: skillTurnOutcome.skillName,
      skillOutcome: skillTurnOutcome.outcome,
      skillStatus: skillTurnOutcome.status,
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
    };
  }

  async presentWithSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    plannedSuggestions: PlannedEnvelopeSuggestion[],
    userExpectedLocale?: string | null,
    grounding: AnswerGroundingVerdict = "grounded",
  ): Promise<ChatPresentedAnswer> {
    const presentation = await this.presentWithoutSuggestions(session, answer, query, userExpectedLocale, grounding);
    const withQuestionSuggestions = this.applyAssistantSuggestions(session, presentation, plannedSuggestions);
    return await this.applyActionSuggestions(session, withQuestionSuggestions, userExpectedLocale);
  }

  async presentWithoutSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
    grounding: AnswerGroundingVerdict = "grounded",
  ): Promise<ChatPresentedAnswer> {
    const citationEvidence = toCitationEvidence(session);

    if (session.retrieval.contexts.length === 0) {
      return {
        ...this.presentNoContextRefusal(answer, citationEvidence),
        effectiveRetrieval: session.retrieval,
      };
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
    const groundedOutcome = grounding === "degraded"
      ? SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED_DEGRADED
      : SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED;

    return withLegacyAnswerOutcome({
      ...presented,
      ...citationArtifacts,
      grounding,
      effectiveRetrieval: session.retrieval,
      planningCitations: toPlanningCitations(normalized.citationEvidence),
      skillName: groundedOutcome.skillName,
      skillOutcome: groundedOutcome.outcome,
      skillStatus: groundedOutcome.status,
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
