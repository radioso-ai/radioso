import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorDatabasePort,
  ConnectorLogger,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import type { ChannelPersonDataEraser } from "../../../../shared/domain/conversationDataErasure.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../../../shared/observability/errorClass.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { WhatsAppClient } from "./whatsappClient.js";
import { WhatsAppMessageHandler } from "./whatsappMessageHandler.js";
import { WhatsAppNumberChanges } from "./whatsappNumberChanges.js";
import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { PostgresWhatsAppPersistence } from "./whatsappPersistence.js";
import { createWhatsAppWebhookRouter, findInboundMessageInPayload } from "./whatsappWebhook.js";

const WHATSAPP_CONFIG_KEYS = {
  phoneNumberId: "phone_number_id",
  accessToken: "access_token",
  appSecret: "app_secret",
  webhookVerifyToken: "webhook_verify_token",
  businessAccountId: "business_account_id",
  conversationTimeoutHours: "conversation_timeout_hours",
  unsupportedMessageReply: "unsupported_message_reply",
} as const;

/** The host services the registry adds to the contract's context. */
type WhatsAppConnectorContext = ConnectorContext & {
  metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
};

interface WhatsAppPluginOptions {
  /** Erases the person values kept under a number, bound to the plugin's database: a sender's old number, once they change it. */
  personValues?: (db: Db) => ChannelPersonDataEraser;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  debounceMs?: number;
  cleanupIntervalMs?: number;
  /** How long an unanswered inbound message must sit untouched before a recovering instance takes it. */
  recoveryLeaseMs?: number;
}

/** The WhatsApp connector's id: its database key and URL segment, and what composition binds its number key to. */
export const WHATSAPP_CONNECTOR_ID = "whatsapp";

export class WhatsAppPlugin implements ConnectorPlugin {
  readonly id = WHATSAPP_CONNECTOR_ID;
  readonly name = "WhatsApp";
  readonly description = "Connect a workspace to WhatsApp Business so incoming messages flow through chat.";

  private static readonly DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  /** An instance refreshes the messages it holds every third of this, so only a message no instance holds ages past it. */
  private static readonly DEFAULT_RECOVERY_LEASE_MS = 5 * 60 * 1000;
  private static readonly MESSAGE_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

  private readonly fetchImpl?: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly debounceMs?: number;
  private readonly cleanupIntervalMs: number;
  private readonly recoveryLeaseMs: number;
  private readonly personValues?: (db: Db) => ChannelPersonDataEraser;
  private initialized = false;
  private messageHandler?: WhatsAppMessageHandler;
  private cleanupTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;

  constructor(options: WhatsAppPluginOptions = {}) {
    this.fetchImpl = options.fetch;
    this.sleep = options.sleep;
    this.debounceMs = options.debounceMs;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? WhatsAppPlugin.DEFAULT_CLEANUP_INTERVAL_MS;
    this.recoveryLeaseMs = options.recoveryLeaseMs ?? WhatsAppPlugin.DEFAULT_RECOVERY_LEASE_MS;
    this.personValues = options.personValues;
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

    const metrics = (context as WhatsAppConnectorContext).metricsRegistry ?? null;
    const client = new WhatsAppClient({
      logger: context.logger,
      fetch: this.fetchImpl,
      // The media link comes from Meta's response, so its bytes are fetched on the connection-bound
      // public transport: only public addresses, and the check holds on the connection itself.
      mediaFetch: this.fetchImpl ?? ((input, init) => context.publicHttp.fetch(input as string | URL, init)),
      sleep: this.sleep,
      metrics,
    });
    const db = connectorKyselyDb(context.db);
    const persistence = new PostgresWhatsAppPersistence(db);
    const messageHandler = new WhatsAppMessageHandler({
      db: context.db,
      logger: context.logger,
      chat: context.chat,
      state: context.state,
      client,
      persistence,
      metrics,
      debounceMs: this.debounceMs,
      heartbeatMs: Math.max(1, Math.floor(this.recoveryLeaseMs / 3)),
    });
    this.messageHandler = messageHandler;

    context.http.mount(
      "/:workspaceId/webhook",
      createWhatsAppWebhookRouter({
        logger: context.logger,
        state: context.state,
        persistence,
        messageHandler,
        ...(this.personValues ? { numberChanges: new WhatsAppNumberChanges({ personValues: this.personValues(db), metrics }) } : {}),
      }),
    );

    await this.cleanupExpiredMessageLogs(context.db, context.logger);
    await this.recoverPendingInboundMessages(persistence, messageHandler, context.logger);
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredMessageLogs(context.db, context.logger);
    }, this.cleanupIntervalMs);
    // A message another instance stopped working on becomes claimable once its lease runs out.
    this.recoveryTimer = setInterval(() => {
      if (this.sweeping) {
        return;
      }
      this.sweeping = this.recoverPendingInboundMessages(persistence, messageHandler, context.logger)
        .catch((error) => {
          context.logger.error({ connectorId: this.id, errorClass: errorClassOf(error) }, "WhatsApp recovery sweep failed");
        })
        .finally(() => { this.sweeping = undefined; });
    }, Math.max(1000, Math.floor(this.recoveryLeaseMs / 2)));

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    // A sweep that is handing rows over finishes before the handler stops, so the handler hands them back.
    await this.sweeping;
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
    const pendingLogs = await persistence.claimRecoverableInboundLogs(this.recoveryLeaseMs);
    if (pendingLogs.length > 0) {
      logger.info({ connectorId: this.id, messageLogIds: pendingLogs.map((log) => log.id) }, "WhatsApp recovery claimed unanswered inbound messages");
    }
    for (const log of pendingLogs) {
      if (messageHandler.holds(log.wamid)) {
        continue;
      }
      const message = findInboundMessageInPayload(log.workspaceId, log.payload, log.wamid);
      if (!message) {
        await persistence.updateMessageLogStatus(log.wamid, "failed", "Unable to recover inbound payload after restart");
        logger.warn({ connectorId: this.id, messageLogId: log.id }, "WhatsApp recovery skipped malformed inbound payload");
        continue;
      }

      await messageHandler.handleInboundMessage(message);
    }
  }
}
