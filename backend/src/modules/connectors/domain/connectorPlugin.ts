import type { Router } from "express";
import type { Database } from "../../../shared/infra/database.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ChatService } from "../../chat/services/chatService.js";
import type { ConnectorRegistry } from "../services/connectorRegistry.js";
import type { ConfigFieldDefinition } from "./configSchema.js";

/**
 * Scoped API surface passed to each connector plugin at initialization.
 */
export interface ConnectorContext {
  db: Database;
  logger: AppLogger;
  chatService: ChatService;
  connectorRegistry: ConnectorRegistry;
  router: Router;
}

/**
 * Lifecycle contract that every connector plugin must implement.
 */
export interface ConnectorPlugin {
  /** Unique identifier (e.g. "whatsapp"). Used as DB key and URL segment. */
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
  migrate(db: Database): Promise<void>;

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
   * Example: "/api/connectors/whatsapp/:workspaceId/webhook"
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
