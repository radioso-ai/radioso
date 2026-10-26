import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import {
  extractErrorLogFields,
  extractProductAnalyticsLogFields,
  extractRetrievalLogFields,
  type AppLogger,
} from "../../../shared/observability/logger.js";
import type { AuditEventInput, ChatAnswerAuditMetadata } from "../contracts/index.js";
import { requestAuditMetadata } from "../../../shared/observability/requestAuditContext.js";
import { auditEventLogFields } from "./auditEventLogFields.js";

export class AuditService {
  constructor(
    private readonly logger: AppLogger,
    private readonly auditEventRepository: AuditEventRepositoryPort,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    const contextualMetadata = requestAuditMetadata(event.eventType);
    const attributedEvent: AuditEventInput = contextualMetadata
      ? { ...event, metadata: { ...event.metadata, ...contextualMetadata } }
      : event;
    await this.auditEventRepository.create({
      accountId: attributedEvent.accountId,
      workspaceId: attributedEvent.workspaceId,
      eventType: attributedEvent.eventType,
      eventStatus: attributedEvent.eventStatus,
      metadata: attributedEvent.metadata,
    });

    this.logRecorded(attributedEvent);
  }

  /**
   * Records events about an organization and a workspace that may be gone by the time they are
   * written, one per `metadata` entry, in one write: a subject still there is pointed at, one gone is
   * named by id in the metadata instead. The proof a deletion leaves when it finishes after its
   * subjects are gone. Logs one line for the write.
   */
  async recordNamingGoneSubjects(event: Omit<AuditEventInput, "metadata"> & {
    accountId: string;
    workspaceId: string;
    metadata: readonly Record<string, unknown>[];
  }): Promise<void> {
    const contextualMetadata = requestAuditMetadata(event.eventType);
    const metadata = event.metadata.map((entry) => ({ ...entry, ...contextualMetadata }));
    await this.auditEventRepository.createNamingGoneSubjects({ ...event, metadata });
    const [only] = metadata;
    this.logRecorded({ ...event, metadata: metadata.length === 1 && only ? only : { events: metadata.length } });
  }

  async recordForLiveConversation(
    event: AuditEventInput,
    conversation: { workspaceId: string; conversationId: string },
  ): Promise<void> {
    const contextualMetadata = requestAuditMetadata(event.eventType);
    const attributedEvent: AuditEventInput = contextualMetadata
      ? { ...event, metadata: { ...event.metadata, ...contextualMetadata } }
      : event;
    const created = await this.auditEventRepository.createIfConversationLive({
      accountId: attributedEvent.accountId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.conversationId,
      eventType: attributedEvent.eventType,
      eventStatus: attributedEvent.eventStatus,
      metadata: attributedEvent.metadata,
    });
    if (!created) {
      this.logger.debug(
        { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
        "chat_answer_audit_skipped_conversation_erased",
      );
      return;
    }
    this.logRecorded(attributedEvent);
  }

  logRecorded(event: AuditEventInput): void {
    this.logger.info(
      {
        audit: auditEventLogFields(event),
        retrieval: extractRetrievalLogFields(event.metadata),
        analytics: extractProductAnalyticsLogFields(event.metadata?.analytics),
        // Not `error`, which the logger serializes as a caught value (`logger.ts`).
        errorEvent: extractErrorLogFields(event.metadata?.error),
      },
      "audit_event",
    );
  }

  async getLatestSuccessfulChatAnswerMetadata(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<ChatAnswerAuditMetadata | null> {
    const latestSuccess = await this.auditEventRepository.findLatestChatAnswerEventByConversationId(
      input.workspaceId,
      input.conversationId,
      "success",
    );

    if (!latestSuccess) {
      return null;
    }

    return latestSuccess.metadata;
  }

  async updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
  }): Promise<void> {
    await this.auditEventRepository.updateChatAnswerSuggestions({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      suggestions: input.suggestions,
    });
  }
}
