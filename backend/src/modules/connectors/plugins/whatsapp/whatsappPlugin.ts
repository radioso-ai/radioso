import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorDatabasePort,
  ConnectorLogger,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import { WhatsAppClient } from "./whatsappClient.js";
import { WhatsAppMessageHandler } from "./whatsappMessageHandler.js";
import { PostgresWhatsAppPersistence } from "./whatsappPersistence.js";
import { createWhatsAppWebhookRouter, findInboundMessageInPayload } from "./whatsappWebhook.js";

export const WHATSAPP_CONFIG_KEYS = {
  phoneNumberId: "phone_number_id",
  accessToken: "access_token",
  appSecret: "app_secret",
  webhookVerifyToken: "webhook_verify_token",
  businessAccountId: "business_account_id",
  conversationTimeoutHours: "conversation_timeout_hours",
  unsupportedMessageReply: "unsupported_message_reply",
} as const;

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
        key: WHATSAPP_CONFIG_KEYS.phoneNumberId,
        label: "Phone Number ID",
        type: "text",
        required: true,
        helpText: "The WhatsApp Business phone number ID that receives and sends messages.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.accessToken,
        label: "Access Token",
        type: "secret",
        required: true,
        helpText: "System user or permanent access token used for WhatsApp Cloud API requests.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.appSecret,
        label: "App Secret",
        type: "secret",
        required: true,
        helpText: "Meta app secret used to verify webhook signatures.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.webhookVerifyToken,
        label: "Webhook Verify Token",
        type: "generated_secret",
        required: true,
        helpText: "Radioso generated this. Paste it into Meta's webhook verification settings.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.businessAccountId,
        label: "Business Account ID",
        type: "text",
        required: true,
        helpText: "WhatsApp Business Account identifier.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.conversationTimeoutHours,
        label: "Conversation Timeout Hours",
        type: "text",
        required: false,
        defaultValue: "24",
        helpText: "How long an inactive sender stays attached to the active conversation.",
      },
      {
        key: WHATSAPP_CONFIG_KEYS.unsupportedMessageReply,
        label: "Unsupported Message Reply",
        type: "text",
        required: false,
        helpText: "Optional exact reply to send when customers send unsupported WhatsApp media or non-text messages.",
      },
    ];
  }

  async migrate(_db: ConnectorDatabasePort): Promise<void> {
    // WhatsApp tables are created by the numbered backend migration 087_whatsapp_connector.sql.
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
      "/:workspaceId/webhook",
      createWhatsAppWebhookRouter({
        logger: context.logger,
        state: context.state,
        persistence,
        messageHandler: this.messageHandler,
      }),
    );

    await this.cleanupExpiredMessageLogs(context.db, context.logger);
    await this.recoverPendingInboundMessages(persistence, this.messageHandler, context.logger);
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
    return WHATSAPP_CONFIG_KEYS.phoneNumberId;
  }

  validateConfig(config: Record<string, string>): ConnectorValidationIssue[] {
    const issues: ConnectorValidationIssue[] = [];
    const rawTimeout = config[WHATSAPP_CONFIG_KEYS.conversationTimeoutHours]?.trim();
    if (rawTimeout) {
      const parsed = Number(rawTimeout);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        issues.push({
          key: WHATSAPP_CONFIG_KEYS.conversationTimeoutHours,
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

  private async recoverPendingInboundMessages(
    persistence: PostgresWhatsAppPersistence,
    messageHandler: WhatsAppMessageHandler,
    logger: ConnectorLogger,
  ): Promise<void> {
    const pendingLogs = await persistence.listRecoverableInboundLogs();
    for (const log of pendingLogs) {
      const message = findInboundMessageInPayload(log.workspaceId, log.payload, log.wamid);
      if (!message) {
        await persistence.updateMessageLogStatus(log.wamid, "failed", "Unable to recover inbound payload after restart");
        logger.warn({ connectorId: this.id, wamid: log.wamid }, "WhatsApp recovery skipped malformed inbound payload");
        continue;
      }

      await messageHandler.handleInboundMessage(message);
    }
  }
}
