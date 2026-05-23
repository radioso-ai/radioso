import type { RetrievalExecutionDiagnostics, RewriteContinuityState } from "../../retrieval/public.js";
import type { ProductAnalyticsEvent } from "../../../shared/analytics/productAnalyticsTypes.js";

export interface AuditEventMetadata extends Record<string, unknown> {
  retrieval?: RetrievalExecutionDiagnostics;
  analytics?: ProductAnalyticsEvent;
  error?: unknown;
}

export interface AuditEventInput {
  accountId?: string | null;
  workspaceId?: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata?: AuditEventMetadata;
}

export interface ChatAnswerAuditMetadata extends AuditEventMetadata {
  conversationId?: string;
  rewriteContinuityState?: RewriteContinuityState;
}

export interface AuditPort {
  record(event: AuditEventInput): Promise<void>;
  getLatestSuccessfulChatAnswerMetadata(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<ChatAnswerAuditMetadata | null>;
  updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
  }): Promise<void>;
}

export type AuditService = AuditPort;
