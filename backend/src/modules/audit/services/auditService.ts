import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import {
  extractErrorLogFields,
  extractProductAnalyticsLogFields,
  extractRetrievalLogFields,
  type AppLogger,
} from "../../../shared/observability/logger.js";
import type { AuditEventInput, ChatAnswerAuditMetadata } from "../contracts/index.js";
import { requestAuditMetadata } from "../../../shared/observability/requestAuditContext.js";

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

  logRecorded(event: AuditEventInput): void {
    this.logger.info(
      {
        audit: event,
        retrieval: extractRetrievalLogFields(event.metadata),
        analytics: extractProductAnalyticsLogFields(event.metadata?.analytics),
        error: extractErrorLogFields(event.metadata?.error),
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
