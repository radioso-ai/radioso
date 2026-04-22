import type { RetrievalExecutionDiagnostics } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import { extractRetrievalLogFields, type AppLogger } from "../../../shared/observability/logger.js";

export interface AuditEventMetadata extends Record<string, unknown> {
  retrieval?: RetrievalExecutionDiagnostics;
}

interface ChatAnswerAuditMetadata extends AuditEventMetadata {
  conversationId?: string;
  rewriteContinuityState?: RewriteContinuityState;
}

export interface AuditEventInput {
  accountId?: string | null;
  workspaceId?: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata?: AuditEventMetadata;
}

export class AuditService {
  constructor(
    private readonly logger: AppLogger,
    private readonly auditEventRepository: AuditEventRepositoryPort,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.auditEventRepository.create({
      accountId: event.accountId,
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      eventStatus: event.eventStatus,
      metadata: event.metadata,
    });

    this.logger.info(
      {
        audit: event,
        retrieval: extractRetrievalLogFields(event.metadata),
      },
      "audit_event",
    );
  }

  async getLatestSuccessfulChatAnswerMetadata(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<ChatAnswerAuditMetadata | null> {
    const events = await this.auditEventRepository.listChatAnswerEventsByConversationId(
      input.workspaceId,
      input.conversationId,
    );
    const latestSuccess = [...events]
      .reverse()
      .find((event) => event.eventStatus === "success" && this.matchesConversation(event, input.conversationId));

    if (!latestSuccess) {
      return null;
    }

    return latestSuccess.metadata as ChatAnswerAuditMetadata;
  }

  private matchesConversation(event: AuditEventRecord, conversationId: string): boolean {
    return event.eventType === "chat.answer" && event.metadata.conversationId === conversationId;
  }
}
