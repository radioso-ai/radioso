import type { RetrievalExecutionDiagnostics, RewriteContinuityState } from "../../retrieval/public.js";
import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type { ProductAnalyticsEvent } from "../../../shared/analytics/productAnalyticsTypes.js";
import type { IncidentEvent } from "../../../shared/incidents/incidentTypes.js";
import {
  extractIncidentLogFields,
  extractProductAnalyticsLogFields,
  extractRetrievalLogFields,
  type AppLogger,
} from "../../../shared/observability/logger.js";

export interface AuditEventMetadata extends Record<string, unknown> {
  retrieval?: RetrievalExecutionDiagnostics;
  analytics?: ProductAnalyticsEvent;
  incident?: IncidentEvent;
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
        analytics: extractProductAnalyticsLogFields(event.metadata?.analytics),
        incident: extractIncidentLogFields(event.metadata?.incident),
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

    return latestSuccess.metadata as ChatAnswerAuditMetadata;
  }

  async updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
    conversationModeMetadata: unknown;
  }): Promise<void> {
    await this.auditEventRepository.updateChatAnswerSuggestions({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      suggestions: input.suggestions,
      conversationModeMetadata: input.conversationModeMetadata,
    });
  }
}
