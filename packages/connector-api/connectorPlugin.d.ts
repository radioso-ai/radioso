import type { Router } from "express";
import type { QueryResultRow } from "pg";
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
    conversationId?: string;
    query: string;
    sourceChannel?: string | null;
  }): Promise<{
    conversationId: string;
    answer: string;
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

export interface ConnectorContext {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  state: ConnectorStatePort;
  http: ConnectorHttpHost;
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
   * Validate connector-specific config beyond basic schema field requirements.
   * Return an array of validation issues (empty = valid).
   */
  validateConfig(config: Record<string, string>): ConnectorValidationIssue[];
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
  webhookPath: string;
}

/**
 * Detail returned when viewing a single connector's configuration.
 */
export interface ConnectorDetail extends ConnectorSummary {
  configSchema: ConfigFieldDefinition[];
  config: Record<string, string> | null;
}
