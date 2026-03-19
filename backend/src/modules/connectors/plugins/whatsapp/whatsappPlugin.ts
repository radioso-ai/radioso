import { readFile } from "node:fs/promises";

import type {
  ConnectorContext,
  ConnectorDatabasePort,
  ConnectorLogger,
  ConnectorPlugin,
  ConnectorValidationIssue,
  ConfigFieldDefinition,
} from "@hivec/connector-api";
import { WhatsAppClient } from "./whatsappClient.js";
import { WhatsAppMessageHandler } from "./whatsappMessageHandler.js";
import { PostgresWhatsAppPersistence } from "./whatsappPersistence.js";
import { createWhatsAppWebhookRouter } from "./whatsappWebhook.js";

const MIGRATION_NAME = "whatsapp/migration.sql";

interface WhatsAppPluginOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  debounceMs?: number;
  cleanupIntervalMs?: number;
}

export class WhatsAppPlugin implements ConnectorPlugin {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";
  readonly description = "Connect a workspace to WhatsApp Business so incoming messages flow through chat.";
  private static readonly DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private static readonly MESSAGE_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly debounceMs?: number;
  private readonly cleanupIntervalMs: number;
  private initialized = false;
  private messageHandler?: WhatsAppMessageHandler;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: WhatsAppPluginOptions = {}) {
    this.fetchImpl = options.fetch;
    this.sleep = options.sleep;
    this.debounceMs = options.debounceMs;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? WhatsAppPlugin.DEFAULT_CLEANUP_INTERVAL_MS;
  }

  configSchema(): ConfigFieldDefinition[] {
    return [
      {
        key: "phone_number_id",
        label: "Phone Number ID",
        type: "text",
        required: true,
        helpText: "The WhatsApp Business phone number ID that receives and sends messages.",
      },
      {
        key: "access_token",
        label: "Access Token",
        type: "secret",
        required: true,
        helpText: "System user or permanent access token used for Cloud API requests.",
      },
      {
        key: "app_secret",
        label: "App Secret",
        type: "secret",
        required: true,
        helpText: "Meta app secret used to verify webhook signatures.",
      },
      {
        key: "webhook_verify_token",
        label: "Webhook Verify Token",
        type: "secret",
        required: true,
        helpText: "Shared secret used for Meta's webhook verification handshake.",
      },
      {
        key: "business_account_id",
        label: "Business Account ID",
        type: "text",
        required: true,
        helpText: "WhatsApp Business Account identifier.",
      },
      {
        key: "conversation_timeout_hours",
        label: "Conversation Timeout Hours",
        type: "text",
        required: false,
        defaultValue: "24",
        helpText: "How long an inactive sender stays attached to the active conversation.",
      },
    ];
  }

  async migrate(db: ConnectorDatabasePort): Promise<void> {
    const existing = await db.query<{ migration_name: string }>(
      `SELECT migration_name
       FROM connector_migrations
       WHERE connector_id = $1 AND migration_name = $2`,
      [this.id, MIGRATION_NAME],
    );
    if (existing.length > 0) {
      return;
    }

    const sql = await readFile(new URL("./migration.sql", import.meta.url), "utf8");
    await db.query(sql);
    await db.query(
      `INSERT INTO connector_migrations (connector_id, migration_name)
       VALUES ($1, $2)`,
      [this.id, MIGRATION_NAME],
    );
  }

  async initialize(context: ConnectorContext): Promise<void> {
    if (this.initialized) {
      return;
    }

    const client = new WhatsAppClient({
      logger: context.logger,
      fetch: this.fetchImpl,
      sleep: this.sleep,
    });
    const persistence = new PostgresWhatsAppPersistence(context.db);
    this.messageHandler = new WhatsAppMessageHandler({
      db: context.db,
      logger: context.logger,
      chat: context.chat,
      state: context.state,
      client,
      persistence,
      debounceMs: this.debounceMs,
    });

    context.http.mount(
      `/${this.id}`,
      createWhatsAppWebhookRouter({
        logger: context.logger,
        state: context.state,
        persistence,
        messageHandler: this.messageHandler,
      }),
    );

    await this.cleanupExpiredMessageLogs(context.db, context.logger);
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredMessageLogs(context.db, context.logger);
    }, this.cleanupIntervalMs);

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.messageHandler?.shutdown();
    this.messageHandler = undefined;
    this.initialized = false;
  }

  getWebhookPath(): string {
    return "/api/connectors/whatsapp/:workspaceId/webhook";
  }

  uniqueChannelField(): string | null {
    return "phone_number_id";
  }

  validateConfig(config: Record<string, string>): ConnectorValidationIssue[] {
    const issues: ConnectorValidationIssue[] = [];
    const rawTimeout = config.conversation_timeout_hours?.trim();
    if (rawTimeout) {
      const parsed = Number(rawTimeout);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        issues.push({
          key: "conversation_timeout_hours",
          message: "Conversation timeout must be a positive integer number of hours",
        });
      }
    }

    return issues;
  }

  private async cleanupExpiredMessageLogs(db: ConnectorDatabasePort, logger: ConnectorLogger): Promise<void> {
    const cutoff = new Date(Date.now() - WhatsAppPlugin.MESSAGE_LOG_RETENTION_MS);
    await db.query(
      `DELETE FROM connector_whatsapp_message_log
       WHERE created_at < $1`,
      [cutoff],
    );
    logger.info({ connectorId: this.id, cutoff: cutoff.toISOString() }, "WhatsApp message log cleanup completed");
  }
}
