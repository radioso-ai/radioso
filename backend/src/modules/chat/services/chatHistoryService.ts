import { notFound } from "../../../shared/domain/errors.js";
import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type {
  ConversationRecord,
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type {
  ConversationMessageSummary,
  MessageRecord,
  MessageRepositoryPort,
} from "../../../db/repositories/messageRepository.js";
import type { RetrievalExecutionDiagnostics, RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { AssistantTurnOutcome, HiddenSupportEvidence, ValidationDisposition } from "./answerSupportValidationTypes.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import type { ChatSuggestion, ConversationModeMetadata } from "../types/chatResponses.js";

export interface ChatConversationSummary {
  id: string;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  anonymousSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string | null;
}

export interface ChatConversationTurnDebug {
  eventStatus: "success" | "failure";
  recordedAt: string;
  stream: boolean;
  citationCount: number;
  answerOutcome?: AssistantTurnOutcome;
  answerSupportPolicy?: AnswerSupportPolicy;
  conversationMode?: ConversationMode;
  conversationModeMetadata?: ConversationModeMetadata;
  validation?: {
    ran: boolean;
    answerModified: boolean;
    unsupportedSegmentCount: number;
    substantiveUnsupportedSegmentCount: number;
    supportedSegmentCount: number;
    nonSubstantiveSegmentCount: number;
    answerSupportPolicy?: AnswerSupportPolicy;
    hiddenSupportUsed?: boolean;
    hiddenSupportKindsUsed?: HiddenSupportEvidence["kind"][];
    segmentResults: Array<{
      originalText: string;
      text: string;
      disposition: ValidationDisposition;
      replacementApplied: boolean;
      reason: string;
      citationIndices?: number[];
    }>;
  };
  retrievalInfo?: RetrievalInfo;
  retrievalTrace?: RetrievalTrace;
  errorMessage?: string | null;
}

export interface ChatConversationTurn {
  id: string;
  role: MessageRecord["role"];
  content: string;
  createdAt: string;
  inputMetadata?: MessageRecord["inputMetadata"];
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  debug?: ChatConversationTurnDebug;
}

export interface ChatConversationDetail {
  conversationId: string;
  workspaceId: string;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messagesTotal: number;
  messageWindowOffset: number;
  messageWindowLimit: number;
  hasOlderMessages: boolean;
  nextCursor: string | null;
  messages: ChatConversationTurn[];
}

export interface ChatConversationPage {
  conversations: ChatConversationSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PublicConversationSummary {
  id: string;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  preview: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConversationPage {
  conversations: PublicConversationSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

interface ChatAuditMetadata {
  answerOutcome?: AssistantTurnOutcome;
  answerSupportPolicy?: AnswerSupportPolicy;
  conversationMode?: ConversationMode;
  conversationModeMetadata?: ConversationModeMetadata;
  assistantMessageId?: string;
  stream?: boolean;
  citationCount?: number;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: unknown[];
  validation?: {
    ran?: boolean;
    answerModified?: boolean;
    unsupportedSegmentCount?: number;
    substantiveUnsupportedSegmentCount?: number;
    supportedSegmentCount?: number;
    nonSubstantiveSegmentCount?: number;
    answerSupportPolicy?: AnswerSupportPolicy;
    hiddenSupportUsed?: boolean;
    hiddenSupportKindsUsed?: unknown[];
    segmentResults?: Array<{
      originalText?: string;
      text?: string;
      disposition?: ValidationDisposition;
      replacementApplied?: boolean;
      reason?: string;
      citationIndices?: number[];
    }>;
  };
  retrieval?: unknown;
  retrievalTrace?: RetrievalTrace;
  errorMessage?: string;
}

interface AssistantTurnArtifacts {
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeSuggestionCitation = (value: unknown): ChatCitation | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { documentId?: unknown; chunkId?: unknown; title?: unknown };
  if (
    typeof candidate.documentId !== "string" ||
    typeof candidate.chunkId !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return undefined;
  }

  return {
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    title: candidate.title,
  };
};

const normalizeSuggestionKind = (value: unknown): ChatSuggestion["kind"] | null => {
  if (value === undefined || value === "deeper") {
    return "deeper";
  }

  return value === "broader" ? "broader" : null;
};

const normalizeChatSuggestion = (value: unknown): ChatSuggestion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { text?: unknown; kind?: unknown; citation?: unknown };
  if (typeof candidate.text !== "string") {
    return null;
  }

  const text = normalizeWhitespace(candidate.text);
  if (!text) {
    return null;
  }

  const kind = normalizeSuggestionKind(candidate.kind);
  if (!kind) {
    return null;
  }

  return {
    text,
    kind,
    citation: normalizeSuggestionCitation(candidate.citation),
  };
};

const toIsoString = (value: Date): string => value.toISOString();

export class ChatHistoryService {
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditEventRepository: AuditEventRepositoryPort,
  ) {}

  async listConversations(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<ChatConversationPage> {
    const { conversations, total, nextCursor, hasMore } = await this.conversationRepository.listPageByWorkspaceId(
      workspaceId,
      input,
    );
    const messageSummaries = await this.messageRepository.summarizeByConversationIds(
      workspaceId,
      conversations.map((conversation) => conversation.id),
    );

    return {
      conversations: conversations.map((conversation) => this.buildSummary(conversation, messageSummaries.get(conversation.id))),
      total,
      nextCursor,
      hasMore,
    };
  }

  async listAnonymousConversations(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<PublicConversationPage> {
    const { conversations, total, nextCursor, hasMore } = await this.conversationRepository.listPageByAnonymousSession(
      workspaceId,
      anonymousSessionId,
      input,
    );
    const messageSummaries = await this.messageRepository.summarizeByConversationIds(
      workspaceId,
      conversations.map((conversation) => conversation.id),
    );

    return {
      conversations: conversations.map((conversation) => {
        const summary = messageSummaries.get(conversation.id);
        return {
          id: conversation.id,
          sourceChannel: conversation.sourceChannel,
          sourceOrigin: conversation.sourceOrigin,
          preview: summary?.preview ?? null,
          messageCount: summary?.messageCount ?? 0,
          createdAt: toIsoString(conversation.createdAt),
          updatedAt: toIsoString(conversation.updatedAt),
        };
      }),
      total,
      nextCursor,
      hasMore,
    };
  }

  async getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<ChatConversationDetail> {
    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const [{ messages, total, nextCursor, hasMore }, messageSummaries] = await Promise.all([
      this.messageRepository.listWindowByConversationId(workspaceId, conversation.id, input),
      this.messageRepository.summarizeByConversationIds(workspaceId, [conversation.id]),
    ]);
    const assistantMessageIds = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id);
    const auditEvents = await this.auditEventRepository.listChatAnswerEventsByAssistantMessageIds(
      workspaceId,
      conversation.id,
      assistantMessageIds,
    );

    const artifactsByAssistantMessageId = this.buildArtifactsIndex(auditEvents);
    const debugByAssistantMessageId = this.buildDebugIndex(auditEvents);
    const messageSummary = messageSummaries.get(conversation.id);

    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      sourceChannel: conversation.sourceChannel,
      sourceOrigin: conversation.sourceOrigin,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messageSummary?.messageCount ?? total,
      userMessageCount: messageSummary?.userMessageCount ?? 0,
      assistantMessageCount: messageSummary?.assistantMessageCount ?? 0,
      messagesTotal: total,
      messageWindowOffset: input.offset ?? 0,
      messageWindowLimit: input.limit,
      hasOlderMessages: hasMore,
      nextCursor,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: toIsoString(message.createdAt),
        inputMetadata: message.inputMetadata,
        citations: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.citations : undefined,
        answerSegments: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.answerSegments : undefined,
        suggestions: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.suggestions : undefined,
        debug: message.role === "assistant" ? debugByAssistantMessageId.get(message.id) : undefined,
      })),
    };
  }

  private buildSummary(
    conversation: ConversationRecord,
    messageSummary?: ConversationMessageSummary,
  ): ChatConversationSummary {
    return {
      id: conversation.id,
      sourceChannel: conversation.sourceChannel,
      sourceOrigin: conversation.sourceOrigin,
      anonymousSessionId: conversation.anonymousSessionId ?? null,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messageSummary?.messageCount ?? 0,
      userMessageCount: messageSummary?.userMessageCount ?? 0,
      assistantMessageCount: messageSummary?.assistantMessageCount ?? 0,
      preview: messageSummary?.preview ?? null,
    };
  }

  private buildDebugIndex(
    auditEvents: AuditEventRecord[],
  ): Map<string, ChatConversationTurnDebug> {
    const index = new Map<string, ChatConversationTurnDebug>();

    for (const event of auditEvents) {
      const metadata = event.metadata as ChatAuditMetadata;
      if (!metadata.assistantMessageId) {
        continue;
      }

      index.set(metadata.assistantMessageId, {
        eventStatus: event.eventStatus === "failure" ? "failure" : "success",
        recordedAt: toIsoString(event.createdAt),
        stream: Boolean(metadata.stream),
        citationCount: typeof metadata.citationCount === "number" ? metadata.citationCount : 0,
        answerOutcome: metadata.answerOutcome,
        answerSupportPolicy:
          metadata.answerSupportPolicy === "strict" || metadata.answerSupportPolicy === "warn" || metadata.answerSupportPolicy === "off"
            ? metadata.answerSupportPolicy
            : undefined,
        conversationMode:
          metadata.conversationMode === "factual" ||
          metadata.conversationMode === "guided" ||
          metadata.conversationMode === "exploratory"
            ? metadata.conversationMode
            : undefined,
        conversationModeMetadata: metadata.conversationModeMetadata
          ? {
              conversationMode:
                metadata.conversationModeMetadata.conversationMode === "factual" ||
                metadata.conversationModeMetadata.conversationMode === "guided" ||
                metadata.conversationModeMetadata.conversationMode === "exploratory"
                  ? metadata.conversationModeMetadata.conversationMode
                  : "guided",
              brevityOverrideApplied: Boolean(metadata.conversationModeMetadata.brevityOverrideApplied),
              expansionApplied: Boolean(metadata.conversationModeMetadata.expansionApplied),
              expansionKind:
                metadata.conversationModeMetadata.expansionKind === "focused" ||
                metadata.conversationModeMetadata.expansionKind === "expansive"
                  ? metadata.conversationModeMetadata.expansionKind
                  : "none",
              suggestionCount:
                typeof metadata.conversationModeMetadata.suggestionCount === "number"
                  ? metadata.conversationModeMetadata.suggestionCount
                  : 0,
              followUpQuestionApplied: Boolean(metadata.conversationModeMetadata.followUpQuestionApplied),
            }
          : undefined,
        validation: metadata.validation
          ? {
              ran: Boolean(metadata.validation.ran),
              answerModified: Boolean(metadata.validation.answerModified),
              unsupportedSegmentCount:
                typeof metadata.validation.unsupportedSegmentCount === "number" ? metadata.validation.unsupportedSegmentCount : 0,
              substantiveUnsupportedSegmentCount:
                typeof metadata.validation.substantiveUnsupportedSegmentCount === "number"
                  ? metadata.validation.substantiveUnsupportedSegmentCount
                  : 0,
              supportedSegmentCount:
                typeof metadata.validation.supportedSegmentCount === "number" ? metadata.validation.supportedSegmentCount : 0,
              nonSubstantiveSegmentCount:
                typeof metadata.validation.nonSubstantiveSegmentCount === "number" ? metadata.validation.nonSubstantiveSegmentCount : 0,
              answerSupportPolicy:
                metadata.validation.answerSupportPolicy === "strict" ||
                metadata.validation.answerSupportPolicy === "warn" ||
                metadata.validation.answerSupportPolicy === "off"
                  ? metadata.validation.answerSupportPolicy
                  : undefined,
              hiddenSupportUsed: metadata.validation.hiddenSupportUsed === true ? true : undefined,
              hiddenSupportKindsUsed: Array.isArray(metadata.validation.hiddenSupportKindsUsed)
                ? metadata.validation.hiddenSupportKindsUsed.filter(
                    (kind): kind is HiddenSupportEvidence["kind"] =>
                      kind === "assistant_name" || kind === "assistant_role" || kind === "answer_instruction",
                  )
                : undefined,
              segmentResults: (metadata.validation.segmentResults ?? []).map((segment) => ({
                originalText: typeof segment.originalText === "string" ? segment.originalText : "",
                text: typeof segment.text === "string" ? segment.text : "",
                disposition: (segment.disposition ?? "non_substantive") as ValidationDisposition,
                replacementApplied: Boolean(segment.replacementApplied),
                reason: typeof segment.reason === "string" ? segment.reason : "unknown",
                citationIndices: Array.isArray(segment.citationIndices)
                  ? segment.citationIndices.filter((value): value is number => typeof value === "number")
                  : undefined,
              })),
            }
          : undefined,
        retrievalInfo: metadata.retrieval
          ? this.retrievalInfoPresenter.present(metadata.retrieval as RetrievalExecutionDiagnostics)
          : undefined,
        retrievalTrace: metadata.retrievalTrace,
        errorMessage: metadata.errorMessage ?? null,
      });
    }

    return index;
  }

  private buildArtifactsIndex(
    auditEvents: AuditEventRecord[],
  ): Map<string, AssistantTurnArtifacts> {
    const index = new Map<string, AssistantTurnArtifacts>();

    for (const event of auditEvents) {
      const metadata = event.metadata as ChatAuditMetadata;
      if (!metadata.assistantMessageId) {
        continue;
      }

      index.set(metadata.assistantMessageId, {
        citations: metadata.citations,
        answerSegments: metadata.answerSegments,
        suggestions: Array.isArray(metadata.suggestions)
          ? metadata.suggestions.flatMap((suggestion) => {
              const normalized = normalizeChatSuggestion(suggestion);
              return normalized ? [normalized] : [];
            })
          : undefined,
      });
    }

    return index;
  }
}
