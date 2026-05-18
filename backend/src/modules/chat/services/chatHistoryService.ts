import { notFound } from "../../../shared/domain/errors.js";
import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type {
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type {
  MessageRecord,
  MessageRepositoryPort,
} from "../../../db/repositories/messageRepository.js";
import type { HistoryItemsRepositoryPort } from "../../../db/repositories/historyItemsRepository.js";
import type { DocumentSearchHistoryEntry } from "../../documents/contracts/index.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  ActivitySummaryPresenter,
  type RetrievalExecutionDiagnostics,
  type ActivitySummary,
  type ActivityTrace,
} from "../../retrieval/public.js";
import type { AssistantTurnOutcome, HiddenSupportEvidence, ValidationDisposition } from "./answerSupportValidationTypes.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import { buildChatConversationSummary, buildHistoryItem } from "./historyItemPresenter.js";
import {
  NoopContactHistoryProvider,
  type ContactHistoryDetail,
  type ContactHistoryPage,
  type ContactHistoryProviderPort,
  type ContactHistorySummary,
} from "./contactHistoryProvider.js";
import {
  NoopAnswerFeedbackHistoryProvider,
  type AnswerFeedbackHistoryProviderPort,
  type ChatAnswerFeedbackEntry,
} from "./answerFeedbackHistoryProvider.js";

export interface ChatConversationSummary {
  id: string;
  agentId: string | null;
  agentName: string | null;
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
  validation?: {
    ran: boolean;
    answerModified: boolean;
    unsupportedSegmentCount: number;
    substantiveUnsupportedSegmentCount: number;
    supportedSegmentCount: number;
    nonSubstantiveSegmentCount: number;
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
  activitySummary?: ActivitySummary;
  activityTrace?: ActivityTrace;
  errorMessage?: string | null;
  route?: {
    generator: string;
    routeType: "direct" | "retrieval";
    routeReason: string;
    retrievalInvoked: boolean;
  };
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
  answerFeedbackEntries?: ChatAnswerFeedbackEntry[];
  debug?: ChatConversationTurnDebug;
}

export interface ChatConversationDetail {
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
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

export type HistoryItem =
  | {
      kind: "chat";
      id: string;
      sortAt: string;
      conversation: ChatConversationSummary;
    }
  | {
      kind: "search";
      id: string;
      sortAt: string;
      search: DocumentSearchHistoryEntry;
    }
  | {
      kind: "contact";
      id: string;
      sortAt: string;
      contact: ContactHistorySummary;
    };

export interface HistoryItemsPage {
  items: HistoryItem[];
  total: number;
  nextCursor: null;
  hasMore: boolean;
}

export interface ContactHistoryDetailResponse {
  contact: ContactHistoryDetail;
  conversation: ChatConversationDetail;
}

export interface PublicConversationSummary {
  id: string;
  agentId: string | null;
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
  activityTrace?: ActivityTrace;
  errorMessage?: string;
  route?: {
    generator?: unknown;
    routeType?: unknown;
    routeReason?: unknown;
    retrievalInvoked?: unknown;
  };
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

const normalizeRouteDiagnostics = (
  value: ChatAuditMetadata["route"],
): ChatConversationTurnDebug["route"] | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const generator = typeof value.generator === "string" && value.generator.trim()
    ? value.generator.trim()
    : undefined;
  const routeType =
    value.routeType === "direct" || value.routeType === "retrieval"
      ? value.routeType
      : undefined;
  const routeReason = typeof value.routeReason === "string" ? value.routeReason : undefined;

  if (!generator || !routeType || !routeReason) {
    return undefined;
  }

  return {
    generator,
    routeType,
    routeReason,
    retrievalInvoked: Boolean(value.retrievalInvoked),
  };
};

const toRetrievalExecutionPath = (
  route: ChatConversationTurnDebug["route"] | undefined,
): ActivitySummary["execution"] | undefined => {
  if (!route || route.generator !== "assistant") {
    return undefined;
  }

  return {
    surface: "assistant",
    path: route.routeType === "direct" ? "assistant_direct" : "assistant_retrieval",
    retrievalInvoked: route.retrievalInvoked,
  };
};

const reconstructActivityTrace = (input: {
  eventId: string;
  startedAt: string;
  route: ChatConversationTurnDebug["route"] | undefined;
  summary: ActivitySummary | undefined;
  diagnostics: RetrievalExecutionDiagnostics;
  answerOutcome?: AssistantTurnOutcome;
  citations?: ChatCitation[];
}): ActivityTrace => {
  const execution = input.summary?.execution ?? toRetrievalExecutionPath(input.route);
  const stages: ActivityTrace["stages"] = [
    {
      stageId: "routing",
      kind: "routing",
      label: "Routing",
      status: input.route?.retrievalInvoked ? "applied" : "skipped",
      startedAt: input.startedAt,
      inputs: {
        surface: execution?.surface,
      },
      outputs: {
        responseIntent: input.diagnostics.responseIntent,
        retrievalInvoked: input.route?.retrievalInvoked,
        retrievalSkipped: input.diagnostics.retrievalSkipped,
      },
      reason: input.route?.routeReason,
    },
  ];

  if (input.diagnostics.parsedQuery || input.diagnostics.rewriteStatus || input.diagnostics.retrievalSubqueries?.length) {
    stages.push({
      stageId: "interpretation",
      kind: "query_interpretation",
      label: "Query interpretation",
      status: input.diagnostics.rewriteStatus === "fallback"
        ? "fallback"
        : input.diagnostics.rewriteStatus === "rejected"
          ? "rejected"
          : input.diagnostics.rewriteStatus === "applied"
            ? "applied"
            : "skipped",
      startedAt: input.startedAt,
      outputs: {
        originalQuery: input.diagnostics.parsedQuery?.originalQuery,
        semanticQuery: input.diagnostics.parsedQuery?.semanticQuery,
        lexicalQuery: input.diagnostics.parsedQuery?.lexicalQuery,
        responseIntent: input.diagnostics.responseIntent,
        retrievalSubqueries: input.diagnostics.retrievalSubqueries,
        rewriteEligible: input.diagnostics.rewriteEligible,
        rewriteRan: input.diagnostics.rewriteRan,
        continuityDecision: input.diagnostics.continuityDecision,
      },
      metrics: typeof input.diagnostics.intentConfidence === "number"
        ? { rewriteConfidence: input.diagnostics.intentConfidence }
        : undefined,
      reason: input.diagnostics.rejectionReason ?? input.diagnostics.fallbackReason,
    });
  }

  if (input.diagnostics.triggerAnalysis) {
    stages.push({
      stageId: "trigger_analysis",
      kind: "trigger_analysis",
      label: "Trigger analysis",
      status: input.diagnostics.triggerAnalysis.status === "fallback"
        ? "fallback"
        : input.diagnostics.triggerAnalysis.status === "applied"
          ? "applied"
          : "skipped",
      startedAt: input.startedAt,
      outputs: {
        consideredRules: input.diagnostics.triggerAnalysis.consideredRules,
        matchedRuleIds: input.diagnostics.triggerAnalysis.matchedRuleIds,
        unmatchedRuleIds: input.diagnostics.triggerAnalysis.unmatchedRuleIds,
        backoffDecision: input.diagnostics.triggerBackoff,
      },
      metrics: {
        consideredRuleCount: input.diagnostics.triggerAnalysis.consideredRules.length,
        matchCount: input.diagnostics.triggerAnalysis.matchCount,
      },
      reason: input.diagnostics.triggerAnalysis.failureReason,
    });
  }

  if (input.diagnostics.shapeSelection || input.summary?.shapeName || input.summary?.skillDiagnostic) {
    stages.push({
      stageId: "shape_selection",
      kind: "shape_selection",
      label: "Shape selection",
      status: "applied",
      startedAt: input.startedAt,
      outputs: {
        skillName: input.summary?.skillDiagnostic?.skillName,
        shapeName: input.summary?.shapeName,
        queryShape: input.summary?.queryShape,
        resolvedSteps: input.summary?.resolvedSteps,
      },
      reason: input.summary?.skillDiagnostic?.selectionReason,
    });
  }

  const citationChunkRefs = (input.citations ?? []).map((citation) => ({
    chunkId: citation.chunkId,
    documentId: citation.documentId,
    title: citation.title,
  }));

  stages.push(
    {
      stageId: "candidate_summary",
      kind: "diagnostics",
      label: "Candidate summary",
      status: input.diagnostics.fallbackApplied ? "fallback" : "applied",
      startedAt: input.startedAt,
      outputs: {
        fallbackApplied: input.diagnostics.fallbackApplied,
        continuityDecision: input.diagnostics.continuityDecision,
        ...(citationChunkRefs.length > 0 ? { finalContexts: citationChunkRefs } : {}),
      },
      metrics: {
        semanticCandidateCount: input.diagnostics.originalCandidateCount + input.diagnostics.rewrittenCandidateCount,
        lexicalCandidateCount: input.diagnostics.lexicalCandidateCount ?? 0,
        mergedCandidateCount: input.diagnostics.normalizedCandidateCount,
        finalContextCount: input.diagnostics.finalContextCount,
      },
    },
    {
      stageId: "answer",
      kind: "answer_outcome",
      label: "Answer outcome",
      status: input.answerOutcome?.includes("unsupported") ? "fallback" : "applied",
      startedAt: input.startedAt,
      outputs: {
        outcome: input.answerOutcome,
      },
    },
  );

  return {
    traceId: `reconstructed-${input.eventId}`,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    totalDurationMs: 0,
    stages,
    links: stages.slice(0, -1).map((stage, index) => ({
      fromStageId: stage.stageId,
      toStageId: stages[index + 1]?.stageId ?? stage.stageId,
      kind: "sequence",
    })),
    summary: input.summary,
  };
};

export class ChatHistoryService {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditEventRepository: AuditEventRepositoryPort,
    private readonly historyItemsRepository: HistoryItemsRepositoryPort,
    private readonly contactHistoryProvider: ContactHistoryProviderPort = new NoopContactHistoryProvider(),
    private readonly answerFeedbackHistoryProvider: AnswerFeedbackHistoryProviderPort =
      new NoopAnswerFeedbackHistoryProvider(),
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
      conversations: conversations.map((conversation) => buildChatConversationSummary(conversation, messageSummaries.get(conversation.id))),
      total,
      nextCursor,
      hasMore,
    };
  }

  async listItems(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ): Promise<HistoryItemsPage> {
    const offset = input.offset ?? 0;
    const sourceLimit = offset + input.limit;
    const [basePage, contactPage] = await Promise.all([
      this.historyItemsRepository.listPageByWorkspaceId(workspaceId, { limit: sourceLimit, offset: 0 }),
      this.contactHistoryProvider.listPageByWorkspaceId(workspaceId, { limit: sourceLimit, offset: 0 }),
    ]);
    const baseItems = basePage.items;
    const contactItems = contactPage.contacts.map((contact): HistoryItem => ({
      kind: "contact",
      id: contact.id,
      sortAt: contact.sortAt,
      contact,
    }));
    const mergedItems = [
      ...baseItems.map((item): HistoryItem => buildHistoryItem(item)),
      ...contactItems,
    ].sort((left, right) => {
      const timeDiff = new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime();
      return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
    });
    const items = mergedItems.slice(offset, offset + input.limit);
    const conversationIds = items.flatMap((item) => item.kind === "chat" ? [item.conversation.id] : []);
    const messageSummaries = await this.messageRepository.summarizeByConversationIds(workspaceId, conversationIds);
    const total = basePage.total + contactPage.total;

    return {
      items: items.map((item): HistoryItem => {
        if (item.kind !== "chat") {
          return item;
        }

        return {
          ...item,
          conversation: {
            ...item.conversation,
            messageCount: messageSummaries.get(item.conversation.id)?.messageCount ?? 0,
            userMessageCount: messageSummaries.get(item.conversation.id)?.userMessageCount ?? 0,
            assistantMessageCount: messageSummaries.get(item.conversation.id)?.assistantMessageCount ?? 0,
            preview: messageSummaries.get(item.conversation.id)?.preview ?? null,
          },
        };
      }),
      total,
      nextCursor: null,
      hasMore: offset + items.length < total,
    };
  }

  async listContacts(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ): Promise<ContactHistoryPage> {
    return this.contactHistoryProvider.listPageByWorkspaceId(workspaceId, input);
  }

  async getContactRequest(
    workspaceId: string,
    requestId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<ContactHistoryDetailResponse> {
    const contact = await this.contactHistoryProvider.getById(workspaceId, requestId);
    if (!contact) {
      throw notFound("Contact request not found");
    }

    return {
      contact,
      conversation: await this.getConversation(workspaceId, contact.conversationId, input, { includeAnswerFeedback: true }),
    };
  }

  async listAnonymousConversations(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null } = { limit: 50, offset: 0 },
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
          agentId: conversation.agentId,
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
    options: { includeAnswerFeedback?: boolean } = {},
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
    const feedbackByAssistantMessageId = options.includeAnswerFeedback
      ? await this.answerFeedbackHistoryProvider.listByAssistantMessageIds(workspaceId, assistantMessageIds)
      : new Map<string, ChatAnswerFeedbackEntry[]>();

    const artifactsByAssistantMessageId = this.buildArtifactsIndex(auditEvents);
    const debugByAssistantMessageId = this.buildDebugIndex(auditEvents);
    const messageSummary = messageSummaries.get(conversation.id);

    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
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
        answerFeedbackEntries: message.role === "assistant" ? feedbackByAssistantMessageId.get(message.id) : undefined,
        debug: message.role === "assistant" ? debugByAssistantMessageId.get(message.id) : undefined,
      })),
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

      const route = normalizeRouteDiagnostics(metadata.route);
      const activitySummary = metadata.activityTrace?.summary
        ?? (
          metadata.retrieval
            ? this.activitySummaryPresenter.present(metadata.retrieval as RetrievalExecutionDiagnostics, {
                execution: toRetrievalExecutionPath(route),
              })
            : undefined
        );
      const activityTrace = metadata.activityTrace
        ?? (
          metadata.retrieval
            ? reconstructActivityTrace({
                eventId: event.id,
                startedAt: toIsoString(event.createdAt),
                route,
                summary: activitySummary,
                diagnostics: metadata.retrieval as RetrievalExecutionDiagnostics,
                answerOutcome: metadata.answerOutcome,
                citations: metadata.citations,
              })
            : undefined
        );
      index.set(metadata.assistantMessageId, {
        eventStatus: event.eventStatus === "failure" ? "failure" : "success",
        recordedAt: toIsoString(event.createdAt),
        stream: Boolean(metadata.stream),
        citationCount: typeof metadata.citationCount === "number" ? metadata.citationCount : 0,
        answerOutcome: metadata.answerOutcome,
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
              hiddenSupportUsed: metadata.validation.hiddenSupportUsed === true ? true : undefined,
              hiddenSupportKindsUsed: Array.isArray(metadata.validation.hiddenSupportKindsUsed)
                ? metadata.validation.hiddenSupportKindsUsed.filter(
                    (kind): kind is HiddenSupportEvidence["kind"] =>
                      kind === "assistant_name",
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
        activitySummary,
        activityTrace,
        errorMessage: metadata.errorMessage ?? null,
        route,
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
