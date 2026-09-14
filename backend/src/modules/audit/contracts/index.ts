import type { Kysely } from "kysely";

import type { RetrievalExecutionDiagnostics, RewriteContinuityState } from "../../retrieval/public.js";
import type { ProductAnalyticsEvent } from "../../../shared/analytics/productAnalyticsTypes.js";
import type { DB } from "../../../shared/infra/kysely/types.js";

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
  /**
   * Stable across delivery attempts, for a caller that may record the same event
   * twice — the audit outbox dispatcher, republishing after an acknowledgement
   * that did not commit — so a retry lands on the same row instead of a second
   * one. Absent it, an id is minted.
   */
  eventId?: string;
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

/**
 * What a caller commits to the platform's audit outbox. The audit module knows
 * nothing about the caller's domain — `eventType` and `eventStatus` are the
 * caller's vocabulary, `metadata` is whatever the caller wants on the trail,
 * and the caller's own rule is identifiers and counts, never a record key or a
 * stored value.
 */
export interface AuditOutboxIntent {
  accountId: string | null;
  /** Null for a host or release-level event that names no workspace. */
  workspaceId: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata: Record<string, unknown>;
}

/**
 * Durable enqueue inside a caller-supplied executor. A `Transaction<DB>` is a
 * `Kysely<DB>`, so a caller that passes its own open transaction gets the
 * intent committed in the same transaction as the change it describes; the
 * outbox itself opens nothing and enforces no atomicity of its own.
 */
export interface AuditOutboxPort {
  /** Returns the enqueued rows' ids, in the order the intents were given. */
  enqueue(executor: Kysely<DB>, intents: readonly AuditOutboxIntent[]): Promise<readonly string[]>;
}

export interface AuditOutboxDrainResult {
  published: number;
  /** Entries whose publish failed. Their lease expires and the next pass retries them. */
  failed: number;
  /** True when a full batch was claimed — there may be more behind it. */
  remaining: boolean;
}

/**
 * Publishes committed intents onto the audit trail. Exposed rather than
 * scheduled: the runtime that owns background work decides the cadence, and a
 * trail that is a few seconds behind is still a trail that agrees with the data.
 */
export interface AuditOutboxDispatcher {
  drain(input?: { batchSize?: number }): Promise<AuditOutboxDrainResult>;
}
