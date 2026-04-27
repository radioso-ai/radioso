import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import { resolveContextSourceUrl } from "../../retrieval/services/contextSourceUrl.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import { DEFAULT_ANSWER_SUPPORT_POLICY } from "../../settings/domain/retrievalSettings.js";
import {
  AnswerPresentationService,
  remapAnswerSegmentsToCitationEvidence,
} from "./answerPresentationService.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type HiddenSupportEvidence,
} from "./answerSupportValidationTypes.js";
import { AnswerSupportValidator } from "./answerSupportValidator.js";
import { AssistantInstructionBuilder } from "./assistantInstructionBuilder.js";
import { AssistantTurnOutcomeClassifier } from "./assistantTurnOutcomeClassifier.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import { ConversationModeExpansionService } from "./conversationModeExpansionService.js";
import type { ChatGateway } from "./chatService.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import type { PreparedSession, PresentedAnswer } from "./chatTurnTypes.js";
import {
  MissingGroundedMissResponseComposer,
  type GroundedMissResponseComposer,
} from "./groundedMissResponseComposer.js";
import { buildNonRetrievalAnswerPrompt } from "./nonRetrievalAnswerPromptBuilder.js";
import type { ConversationModeMetadata } from "../types/chatResponses.js";

const DIRECT_ANSWER_PATTERNS = [
  /\bjust the answer\b/i,
  /\bjust answer\b/i,
  /\bbriefly\b/i,
  /\bbe brief\b/i,
  /\bshort answer\b/i,
  /\bone sentence\b/i,
  /\bconcise\b/i,
  /\bsuccinct\b/i,
  /\bno follow[- ]up\b/i,
  /\bwithout extra detail/i,
  /\bsolo la risposta\b/i,
  /\bin breve\b/i,
];

const shouldSuppressOptionalSuggestions = (query: string): boolean =>
  DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(query));

const inferConversationModeMetadata = (input: {
  conversationMode: ConversationMode;
  brevityOverrideApplied: boolean;
  suggestionCount: number;
  followUpQuestionApplied?: boolean;
}): Omit<ConversationModeMetadata, "conversationMode" | "brevityOverrideApplied"> => {
  if (input.brevityOverrideApplied) {
    return {
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: false,
    };
  }

  const expansionApplied = input.suggestionCount > 0;
  if (!expansionApplied) {
    return {
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: Boolean(input.followUpQuestionApplied),
    };
  }

  return {
    expansionApplied: true,
    expansionKind: input.conversationMode === "exploratory" ? "expansive" : "focused",
    suggestionCount: input.suggestionCount,
    followUpQuestionApplied: Boolean(input.followUpQuestionApplied),
  };
};

const isBlankChatAnswerError = (error: unknown): boolean =>
  error instanceof Error && error.name === "BlankChatAnswerError";

const buildHiddenSupportEvidence = (
  responseIdentity?: ResponseIdentity | null,
): HiddenSupportEvidence[] => {
  if (!responseIdentity) {
    return [];
  }

  const evidence: HiddenSupportEvidence[] = [];

  if (responseIdentity.name) {
    evidence.push({
      kind: "assistant_name",
      content: responseIdentity.name,
    });
  }

  if (responseIdentity.role) {
    evidence.push({
      kind: "assistant_role",
      content: responseIdentity.role,
    });
  }

  return evidence;
};

export class ChatAnswerPresentationFlow {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly answerSupportValidator = new AnswerSupportValidator();
  private readonly assistantTurnOutcomeClassifier = new AssistantTurnOutcomeClassifier();
  private readonly assistantInstructionBuilder = new AssistantInstructionBuilder();
  private readonly conversationModeExpansionService: ConversationModeExpansionService;

  constructor(
    private readonly chatGateway: ChatGateway,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer = new MissingGroundedMissResponseComposer(),
  ) {
    this.conversationModeExpansionService = new ConversationModeExpansionService(async ({ query, history, prompt }) =>
      this.chatGateway.answer({
        query,
        history,
        prompt,
      }));
  }

  getConversationMode(session: PreparedSession): ConversationMode {
    return session.retrieval.responseSettings?.conversationMode ?? "guided";
  }

  getConversationModeMetadata(session: PreparedSession, input?: Partial<ConversationModeMetadata>): ConversationModeMetadata {
    return {
      conversationMode: this.getConversationMode(session),
      brevityOverrideApplied: false,
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: false,
      ...input,
    };
  }

  async generateAnswerPresentation(
    session: PreparedSession,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<PresentedAnswer> {
    if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
      const nonRetrievalAnswer = await this.generateNonRetrievalAnswer(session, query);
      if (nonRetrievalAnswer) {
        return nonRetrievalAnswer;
      }
    }

    const answer = session.retrieval.contexts.length === 0
      ? await this.groundedMissResponseComposer.composeNoContext({
          query,
          conversationMode: this.getConversationMode(session),
          userExpectedLocale,
        })
      : await this.chatGateway.answer({
          query,
          history: session.history,
          prompt: session.retrieval.prompt,
        });

    return this.presentAnswer(session, answer, query, userExpectedLocale);
  }

  async generateNonRetrievalAnswer(
    session: PreparedSession,
    query: string,
  ): Promise<PresentedAnswer | null> {
    if (session.turnRoute === CHAT_TURN_ROUTE.RETRIEVAL) {
      return null;
    }

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
          answerInstructionBlock: this.assistantInstructionBuilder.buildCombinedBlock({
            responseIdentity: session.retrieval.responseIdentity,
            customInstruction: session.retrieval.responseSettings.customInstruction,
            conversationMode: session.retrieval.responseSettings.conversationMode,
            responseLanguagePolicy: session.retrieval.responseSettings.responseLanguagePolicy,
          }),
        }),
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

    const presented = this.answerPresentationService.present({
      answer,
      citations: [],
      citationDisplayEnabled: false,
    });

    return {
      ...presented,
      planningCitations: [],
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
      validation: {
        ran: false,
        answerModified: false,
        unsupportedSegmentCount: 0,
        substantiveUnsupportedSegmentCount: 0,
        supportedSegmentCount: 0,
        nonSubstantiveSegmentCount: 0,
        answerSupportPolicy: this.getAnswerSupportPolicy(session),
      },
      segmentResults: [],
      conversationModeMetadata: this.getConversationModeMetadata(session),
    };
  }

  async presentAnswerWithoutSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<PresentedAnswer> {
    const basePresentation = await this.presentValidatedAnswer(session, answer, query, userExpectedLocale);

    return {
      ...basePresentation,
      suggestions: undefined,
      conversationModeMetadata: this.getConversationModeMetadata(session),
    };
  }

  async applyConversationMode(
    session: PreparedSession,
    presentation: Omit<PresentedAnswer, "conversationModeMetadata">,
  ): Promise<PresentedAnswer> {
    const conversationMode = this.getConversationMode(session);
    const brevityOverrideApplied = shouldSuppressOptionalSuggestions(session.userMessage.content);

    if (brevityOverrideApplied) {
      return {
        ...presentation,
        suggestions: undefined,
        conversationModeMetadata: this.getConversationModeMetadata(session, {
          brevityOverrideApplied: true,
          ...inferConversationModeMetadata({
            conversationMode,
            brevityOverrideApplied: true,
            suggestionCount: 0,
          }),
        }),
      };
    }

    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    const expanded = await this.conversationModeExpansionService.apply({
      query: session.userMessage.content,
      conversationMode,
      suggestedQuestionsEnabled: this.getSuggestedQuestionsEnabled(session),
      suggestedQuestionsCount: this.getSuggestedQuestionsCount(session),
      groundedAnswerSupported: presentation.validation.supportedSegmentCount > 0,
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
      suppressOptionalSuggestions: brevityOverrideApplied,
    });
    const suggestions = expanded.suggestions;

    return {
      ...presentation,
      suggestions,
      conversationModeMetadata: this.getConversationModeMetadata(session, inferConversationModeMetadata({
        conversationMode,
        brevityOverrideApplied,
        suggestionCount: suggestions?.length ?? 0,
      })),
    };
  }

  private async presentAnswer(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<PresentedAnswer> {
    const basePresentation = await this.presentValidatedAnswer(session, answer, query, userExpectedLocale);

    return this.applyConversationMode(session, basePresentation);
  }

  private async presentValidatedAnswer(
    session: PreparedSession,
    answer: string,
    query: string,
    userExpectedLocale?: string | null,
  ): Promise<Omit<PresentedAnswer, "suggestions" | "conversationModeMetadata">> {
    const citationEvidence = session.retrieval.contexts.map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
      sourceUrl: resolveContextSourceUrl(context.metadata),
    }));
    const hiddenSupportEvidence = buildHiddenSupportEvidence(session.retrieval.responseIdentity);
    const citationDisplayEnabled = session.retrieval.responseSettings?.citationDisplayEnabled ?? true;

    if (session.retrieval.contexts.length === 0) {
      const presented = this.answerPresentationService.present({
        answer,
        citations: citationEvidence,
        citationDisplayEnabled,
      });

      return {
        ...presented,
        planningCitations: [],
        answerOutcome: ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
        validation: {
          ran: false,
          answerModified: false,
          unsupportedSegmentCount: 0,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
          answerSupportPolicy: this.getAnswerSupportPolicy(session),
        },
        segmentResults: [],
      };
    }

    const normalized = this.answerPresentationService.normalize({
      answer,
      citations: citationEvidence,
    });
    const validationAnswerSegments = remapAnswerSegmentsToCitationEvidence(
      normalized.answerSegments,
      normalized.citationEvidence,
      citationEvidence,
    );

    const validated = await this.answerSupportValidator.validate({
      query,
      answer: normalized.answer,
      answerSegments: validationAnswerSegments,
      citationEvidence,
      hiddenSupportEvidence,
      retrievedContextSummaries: citationEvidence.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled,
      answerSupportPolicy: this.getAnswerSupportPolicy(session),
      conversationMode: this.getConversationMode(session),
      groundedMissResponseComposer: this.groundedMissResponseComposer,
      unsupportedNoticeMarked: normalized.unsupportedNoticeMarked,
      userExpectedLocale,
    });

    return {
      ...validated,
      planningCitations: normalized.citationEvidence.map((citation) => ({
        documentId: citation.documentId,
        chunkId: citation.chunkId,
        title: citation.title,
      })),
      answerOutcome: this.assistantTurnOutcomeClassifier.classify({
        hadRetrievedContext: true,
        validation: validated.validation,
      }),
    };
  }

  private getAnswerSupportPolicy(session: PreparedSession): AnswerSupportPolicy {
    return session.retrieval.responseSettings?.answerSupportPolicy ?? DEFAULT_ANSWER_SUPPORT_POLICY;
  }

  private getSuggestedQuestionsEnabled(session: PreparedSession): boolean {
    return session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true;
  }

  private getSuggestedQuestionsCount(session: PreparedSession): number {
    return session.retrieval.responseSettings?.suggestedQuestionsCount ?? 3;
  }
}
