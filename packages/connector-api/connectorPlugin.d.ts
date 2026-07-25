import type { Router } from "express";
import type { QueryResultRow } from "pg";
import type { ConversationChannelContext } from "@radioso/conversation-contract";
import type { ConfigFieldDefinition } from "./configSchema.js";

/**
 * Connector-owned host ports. Concrete app services are adapted into these ports by the registry.
 */
export interface ConnectorLogger {
  info(entry: unknown, message?: string): void;
  warn(entry: unknown, message?: string): void;
  error(entry: unknown, message?: string): void;
}

export interface ConnectorDatabasePort {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ConnectorChatPort {
  answer(input: {
    workspaceId: string;
    agentId?: string;
    conversationId?: string;
    query: string;
    sourceChannel?: string | null;
    // Message-queue impact: synchronous connector chat port only; no AMQP or worker payload changes.
    channelContext?: ConversationChannelContext | null;
  }): Promise<{
    conversationId: string;
    answer: string;
    outcome: "answered" | "no_context";
  }>;
}

export interface ConnectorStatePort {
  getConfig(workspaceId: string): Promise<{
    enabled: boolean;
    config: Record<string, string>;
  } | null>;
  setErrorStatus(workspaceId: string, errorStatus: string | null): Promise<void>;
}

export interface ConnectorHttpHost {
  mount(path: string, router: Router): void;
}

/**
 * Source descriptor a connector hands to the ingestion port so that documents
 * and the "Sources" view are tagged with the upstream channel they belong to.
 *
 * `externalId` is the connector-scoped identity of the channel (e.g.
 * `"wordpress:https://example.com"`); it scopes the upsert key alongside the
 * workspace, so the connector owns the namespace.
 */
export interface ConnectorSourceDescriptor {
  externalId: string;
  name: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * How the connector's `content` payload should be interpreted by the ingestion
 * pipeline.
 *
 * - `text` (default): treat the payload as already-clean text/markdown.
 * - `html`: run the payload through the application's HTML-to-text normalizer
 *   before sanitisation. Connectors that ingest HTML (e.g. WordPress post
 *   bodies, which include block-builder wrappers and inline styles) opt into
 *   this so they don't have to ship their own extractor.
 */
export type ConnectorIngestContentFormat = "text" | "html";

/**
 * Document ingestion port exposed to connectors. Encapsulates the full ingest
 * pipeline (sanitization, externalDocumentId upsert, queueing, audit, analytics,
 * usage limits) so connector plugins never touch the documents schema directly.
 */
export interface ConnectorIngestionPort {
  ingest(input: {
    workspaceId: string;
    title: string;
    content: string;
    contentFormat?: ConnectorIngestContentFormat;
    externalDocumentId: string;
    metadata?: Record<string, unknown>;
    source?: ConnectorSourceDescriptor;
  }): Promise<{ documentId: string; status: string }>;

  /**
   * Delete the document keyed by
   * (workspaceId, source, externalDocumentId), if any.
   * Returns true when a document was found and deleted, false when no document
   * matched. Idempotent — safe to call for unknown external ids.
   */
  deleteByExternalId(input: {
    workspaceId: string;
    externalDocumentId: string;
    source: ConnectorSourceDescriptor;
  }): Promise<boolean>;

  /**
   * Upsert the document source row for a connector channel without ingesting
   * any documents. Used by connector lifecycle hooks (e.g. onEnable) so the
   * Sources view reflects the wired channel before the first document arrives.
   */
  ensureSource(input: {
    workspaceId: string;
    source: ConnectorSourceDescriptor;
  }): Promise<{ id: string }>;
}

export interface ConnectorContext {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  state: ConnectorStatePort;
  http: ConnectorHttpHost;
  ingestion: ConnectorIngestionPort;
}

/**
 * Lifecycle contract that every connector plugin must implement.
 */
export interface ConnectorPlugin {
  /** Unique identifier (for example, "sms"). Used as DB key and URL segment. */
  readonly id: string;

  /** Human-readable name shown in the Settings UI. */
  readonly name: string;

  /** Short description shown on the connector card. */
  readonly description: string;

  /** Declarative config schema rendered generically by the frontend. */
  configSchema(): ConfigFieldDefinition[];

  /**
   * Run connector-specific database migrations.
   * Called after core migrations, before initialize().
   */
  migrate(db: ConnectorDatabasePort): Promise<void>;

  /**
   * Start the connector: mount webhook routes, start background jobs, etc.
   * Only called for connectors that have at least one enabled workspace config.
   */
  initialize(context: ConnectorContext): Promise<void>;

  /**
   * Graceful shutdown: cancel timers, close connections, etc.
   */
  shutdown(): Promise<void>;

  /**
   * Returns the webhook URL template for this connector.
   * The host portion is filled in by the registry/UI.
   * Example: "/api/connectors/sms/:workspaceId/webhook"
   */
  getWebhookPath(): string;

  /**
   * Optional: declare which config field must be globally unique across workspaces.
   * Used by ConnectorRegistry to enforce FR-012 (e.g. one phone_number_id per workspace).
   * Return null if no uniqueness constraint applies.
   */
  uniqueChannelField(): string | null;

  /**
   * Optional policy for connectors whose generated credentials authenticate a
   * unique upstream channel. When true, changing the unique channel field
   * rotates every generated_secret so the previous channel can no longer send
   * authenticated events.
   */
  rotateGeneratedSecretsOnUniqueChannelChange?(): boolean;

  /**
   * Validate connector-specific config beyond basic schema field requirements.
   * Return an array of validation issues (empty = valid).
   */
  validateConfig(config: Record<string, string>): ConnectorValidationIssue[];

  /**
   * Best-effort hook called after a workspace successfully enables this
   * connector. Use it for one-off side effects like registering a source row
   * so the channel shows up in the Sources view immediately.
   *
   * Throwing here does not roll back the enable; the registry logs and moves on.
   */
  onEnable?(input: { workspaceId: string }): Promise<void>;

  /**
   * Optional manual sync entry point for admin UI actions. Connector plugins
   * decide what "sync now" means for their upstream, but it should be safe to
   * call repeatedly. Implementations should accept work quickly and report an
   * already-running sync instead of starting overlapping work.
   */
  syncNow?(input: { workspaceId: string }): Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
}

export interface ConnectorValidationIssue {
  key: string;
  message: string;
}

/**
 * Summary returned when listing available connectors.
 */
export interface ConnectorSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  errorStatus: string | null;
  supportsManualSync: boolean;
  webhookPath: string;
}

export interface ConnectorSyncState {
  backfillCompletedAt: string | null;
  syncRequestedAt: string | null;
  syncStartedAt: string | null;
  lastRunAt: string | null;
  lastModifiedAt: string | null;
  lastIngestedCount: number | null;
  /** Operator-safe reason for the latest failed sync; cleared after success. */
  lastError: string | null;
}

/**
 * Detail returned when viewing a single connector's configuration.
 */
export interface ConnectorDetail extends ConnectorSummary {
  configSchema: ConfigFieldDefinition[];
  config: Record<string, string> | null;
  syncState: ConnectorSyncState;
}
