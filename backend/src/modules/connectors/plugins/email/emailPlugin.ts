import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import type { EmailChannelSweep, EmailInboundRepository } from "../../../emailChannel/public.js";
import type { InboundEmailReceiver } from "../../../mail/public.js";
import { EmailChannelWorker } from "./emailChannelWorker.js";
import { EmailInboundProcessor, type EmailInboundProcessorDependencies } from "./emailInboundProcessor.js";
import { createEmailWebhookRouter, type EmailWebhookRouterOptions } from "./emailWebhook.js";

interface EmailChannelConnectorDependencies extends Omit<EmailInboundProcessorDependencies, "receiver" | "inbound" | "logger"> {
  receiver: Pick<InboundEmailReceiver, "provider" | "verify" | "fetchMessage">;
  inbound: EmailInboundProcessorDependencies["inbound"] & Pick<EmailInboundRepository, "insertEvent" | "claimDueEvents">;
  logger: {
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  /** `EMAIL_CHANNEL_WORKERS_ENABLED`. */
  workersEnabled: boolean;
  sweep: Pick<EmailChannelSweep, "run" | "reconcileSends">;
}

/**
 * The email channel's connector side: the webhook plugin and the worker that drains what the
 * webhook persists, both over the same inbound repository and drain dispatcher.
 */
export const createEmailChannelConnector = (
  deps: EmailChannelConnectorDependencies,
): { plugin: EmailPlugin; worker: EmailChannelWorker } => ({
  plugin: new EmailPlugin({ receiver: deps.receiver, events: deps.inbound, drains: deps.drains, metrics: deps.metrics, clock: deps.clock }),
  worker: new EmailChannelWorker({
    enabled: deps.workersEnabled,
    events: deps.inbound,
    processor: new EmailInboundProcessor(deps),
    sweep: deps.sweep,
    logger: deps.logger,
  }),
});

/**
 * The email channel as a connector: its one HTTP surface, the provider webhook. The channel's
 * composition builds it, through `createEmailChannelConnector`, only when a provider is configured.
 */
export class EmailPlugin implements ConnectorPlugin {
  readonly id = "email";
  readonly name = "Email";
  readonly description = "Receive a support mailbox's email in the Radioso inbox.";

  private initialized = false;

  constructor(private readonly options: Omit<EmailWebhookRouterOptions, "logger">) {}

  configSchema(): ConfigFieldDefinition[] {
    return [];
  }

  async migrate(): Promise<void> {
    // Email channel tables are created by numbered backend migrations from 209.
  }

  async initialize(context: ConnectorContext): Promise<void> {
    if (this.initialized) {
      return;
    }
    // The router reads the raw body the host captures; the signature is computed over it.
    context.http.mount("/", createEmailWebhookRouter({ ...this.options, logger: context.logger }));
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  getWebhookPath(): string {
    return "/api/connectors/email/webhook";
  }

  uniqueChannelField(): string | null {
    return null;
  }

  validateConfig(): ConnectorValidationIssue[] {
    return [];
  }
}
