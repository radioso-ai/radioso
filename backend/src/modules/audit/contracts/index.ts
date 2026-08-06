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
  // "cancelled" records a turn a newer message superseded: the turn never produced an
  // error, so it must not be conflated with "failure" in error-rate reporting.
  eventStatus: "success" | "failure" | "cancelled";
  metadata?: AuditEventMetadata;
}

export interface ChatAnswerAuditMetadata extends AuditEventMetadata {
  conversationId?: string;
  rewriteContinuityState?: RewriteContinuityState;
}

export interface AuditPort {
  record(event: AuditEventInput): Promise<void>;
  logRecorded?(event: AuditEventInput): void;
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
