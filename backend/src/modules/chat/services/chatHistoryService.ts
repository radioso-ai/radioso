import { notFound } from "../../../shared/domain/errors.js";
import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type {
  ConversationRecord,
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { RetrievalExecutionDiagnostics, RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";

export interface ChatConversationSummary {
  id: string;
  sourceChannel: string | null;
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
  retrievalInfo?: RetrievalInfo;
  retrievalTrace?: RetrievalTrace;
  errorMessage?: string | null;
}

export interface ChatConversationTurn {
  id: string;
  role: MessageRecord["role"];
  content: string;
  createdAt: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  debug?: ChatConversationTurnDebug;
}

export interface ChatConversationDetail {
  conversationId: string;
  workspaceId: string;
  sourceChannel: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messages: ChatConversationTurn[];
}

interface ChatAuditMetadata {
  assistantMessageId?: string;
  stream?: boolean;
  citationCount?: number;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  retrieval?: unknown;
  retrievalTrace?: RetrievalTrace;
  errorMessage?: string;
}

interface AssistantTurnArtifacts {
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

const toIsoString = (value: Date): string => value.toISOString();

const buildPreview = (messages: MessageRecord[]): string | null => {
  const latestMessage = [...messages].reverse().find((message) => message.content.trim().length > 0);
  if (!latestMessage) {
    return null;
  }

  const normalized = latestMessage.content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
};

export class ChatHistoryService {
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditEventRepository: AuditEventRepositoryPort,
  ) {}

  async listConversations(workspaceId: string): Promise<ChatConversationSummary[]> {
    const conversations = await this.conversationRepository.listByWorkspaceId(workspaceId);

    const summaries = await Promise.all(
      conversations.map(async (conversation) => {
        const messages = await this.messageRepository.listByConversationId(conversation.id);
        return this.buildSummary(conversation, messages);
      }),
    );

    return summaries;
  }

  async getConversation(workspaceId: string, conversationId: string): Promise<ChatConversationDetail> {
    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const [messages, auditEvents] = await Promise.all([
      this.messageRepository.listByConversationId(conversation.id),
      this.auditEventRepository.listChatAnswerEventsByConversationId(workspaceId, conversation.id),
    ]);

    const artifactsByAssistantMessageId = this.buildArtifactsIndex(auditEvents);
    const debugByAssistantMessageId = this.buildDebugIndex(auditEvents);
    const userMessageCount = messages.filter((message) => message.role === "user").length;
    const assistantMessageCount = messages.filter((message) => message.role === "assistant").length;

    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      sourceChannel: conversation.sourceChannel,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messages.length,
      userMessageCount,
      assistantMessageCount,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: toIsoString(message.createdAt),
        citations: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.citations : undefined,
        answerSegments: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.answerSegments : undefined,
        debug: message.role === "assistant" ? debugByAssistantMessageId.get(message.id) : undefined,
      })),
    };
  }

  private buildSummary(
    conversation: ConversationRecord,
    messages: MessageRecord[],
  ): ChatConversationSummary {
    return {
      id: conversation.id,
      sourceChannel: conversation.sourceChannel,
      anonymousSessionId: conversation.anonymousSessionId ?? null,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messages.length,
      userMessageCount: messages.filter((message) => message.role === "user").length,
      assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
      preview: buildPreview(messages),
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
      });
    }

    return index;
  }
}
