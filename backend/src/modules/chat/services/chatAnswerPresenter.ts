import { resolveContextSourceUrl } from "../../retrieval/public.js";
import {
  AnswerPresentationService,
  type AnswerPresentationMetrics,
} from "./answerPresentationService.js";
import type { AnswerSegment, ChatCitation, CitationEvidence } from "../contracts/answerTypes.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
  SKILL_TURN_OUTCOME,
  type SkillTurnOutcome,
  type TurnDeclineReason,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import type { AssistantSuggestionExpansionService } from "./assistantSuggestionExpansionService.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import type { ChatActionSuggestionService } from "./actionSuggestions/chatActionSuggestionService.js";
import type { PlannedEnvelopeSuggestion } from "./groundedAnswerEnvelope.js";
import type { GroundingSummary, GroundingVerdict } from "./groundingAssertions.js";
import {
  diagnoseImplicitCitationSupport,
  type ImplicitCitationDiagnostics,
} from "./implicitCitationDiagnostics.js";

export interface ChatGroundingDiagnostics extends ImplicitCitationDiagnostics {
  parseStatus: GroundingSummary["parseStatus"];
  claimCount: number;
  sourcedClaimCount: number;
  unsourcedClaimCount: number;
  invalidSourceCount: number;
  assertionMismatch: boolean;
}

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
  // Computed from the v2 manifest and inline assertions. Raw envelope JSON is
  // deliberately never carried beyond generation finalization.
  grounding?: GroundingVerdict;
  groundingSummary?: GroundingSummary;
  groundingDiagnostics?: ChatGroundingDiagnostics;
  /**
   * Opaque metadata patch a composer's answer side channel attaches to the turn
   * (e.g. directive-adherence attestation). The composer does not interpret it; the
   * chat→engine adapter forwards the recognized keys onto the trace.
   */
  metadata?: Record<string, unknown>;
}

/**
 * What the composer concluded about the answer it produced: how well evidence
 * supported it, and — when the composer already knows, because it composed the
 * decline itself — why the turn declined. One named parameter rather than a growing
 * tail of positional arguments; a decline reason carried on the grounding summary
 * needs no second argument at all.
 */
export interface AnswerVerdict {
  grounding?: GroundingSummary | GroundingVerdict;
  declineReason?: TurnDeclineReason;
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
  private readonly answerPresentationService: AnswerPresentationService;

  constructor(
    private readonly assistantSuggestionExpansionService: AssistantSuggestionExpansionService,
    private readonly chatActionSuggestionService?: ChatActionSuggestionService,
    private readonly skillOutcomeCapabilities: SkillOutcomeCapabilityProvider = {
      supportsGroundedAnswer: () => false,
    },
    metrics?: AnswerPresentationMetrics | null,
  ) {
    this.answerPresentationService = new AnswerPresentationService(metrics);
  }

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

    return {
      ...presented,
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
    verdict: AnswerVerdict = {},
  ): Promise<ChatPresentedAnswer> {
    const presentation = await this.presentWithoutSuggestions(session, answer, query, userExpectedLocale, verdict);
    const withQuestionSuggestions = this.applyAssistantSuggestions(session, presentation, plannedSuggestions);
    return await this.applyActionSuggestions(session, withQuestionSuggestions, userExpectedLocale);
  }

  async presentWithoutSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
    verdict: AnswerVerdict = {},
  ): Promise<ChatPresentedAnswer> {
    const grounding = verdict.grounding ?? "grounded";
    const citationEvidence = toCitationEvidence(session);
    const groundingSummary = typeof grounding === "string" ? undefined : grounding;
    const groundingVerdict = typeof grounding === "string" ? grounding : grounding.verdict;
    const normalized = this.answerPresentationService.normalize({ answer, citations: citationEvidence });
    const implicitDiagnostics = diagnoseImplicitCitationSupport(normalized.answerSegments, citationEvidence);
    const groundingDiagnostics = groundingSummary
      ? {
          parseStatus: groundingSummary.parseStatus,
          claimCount: groundingSummary.claimCount,
          sourcedClaimCount: groundingSummary.sourcedClaimCount,
          unsourcedClaimCount: groundingSummary.unsourcedClaimCount,
          invalidSourceCount: groundingSummary.invalidSourceCount,
          assertionMismatch: groundingSummary.assertionMismatch,
          ...implicitDiagnostics,
        }
      : undefined;

    if (groundingVerdict === "no_support") {
      const declineReason = verdict.declineReason ?? groundingSummary?.declineReason;
      if (!declineReason) {
        throw new Error("retrieval_decline_reason_required");
      }
      return {
        ...this.presentRetrievalDecline(
          answer,
          citationEvidence,
          declineReason,
        ),
        grounding: groundingVerdict,
        groundingSummary,
        groundingDiagnostics,
        effectiveRetrieval: session.retrieval,
      };
    }

    const presented = this.answerPresentationService.present({
      answer,
      citations: citationEvidence,
    });
    const groundedOutcome = groundingVerdict === "degraded"
      ? SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED_DEGRADED
      : SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED;

    return withLegacyAnswerOutcome({
      ...presented,
      grounding: groundingVerdict,
      groundingSummary,
      groundingDiagnostics,
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

  private presentRetrievalDecline(
    answer: string,
    citationEvidence: CitationEvidence[],
    declineReason: TurnDeclineReason,
  ): ChatPresentedAnswer {
    const presented = this.answerPresentationService.present({
      answer,
      citations: citationEvidence,
    });
    const declineOutcome = declineReason === "out_of_scope"
      ? SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE
      : declineReason === "generation_unavailable"
        ? SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE
        : SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT;

    return withLegacyAnswerOutcome({
      ...presented,
      suggestions: undefined,
      planningCitations: [],
      skillName: declineOutcome.skillName,
      skillOutcome: declineOutcome.outcome,
      skillStatus: declineOutcome.status,
    });
  }

  presentRetrievalDeclineAnswer(
    answer: string,
    declineReason: TurnDeclineReason,
  ): ChatPresentedAnswer {
    return this.presentRetrievalDecline(answer, [], declineReason);
  }
}
