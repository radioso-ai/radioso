import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import { OauthConnectionRepository } from "../../../../db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../../integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
  SlackInstallationService,
  type SlackWebApiClient,
} from "../../../slack/public.js";
import { SlackMessageHandler, type SlackWebApiClientFactory } from "./slackMessageHandler.js";
import { PostgresSlackPersistence } from "./slackPersistence.js";
import { createSlackWebhookRouter } from "./slackWebhook.js";

export interface SlackPluginOptions {
  signingSecret: string;
  encryptionKey?: string;
  clientFactory?: SlackWebApiClientFactory;
}

export class SlackPlugin implements ConnectorPlugin {
  readonly id = "slack";
  readonly name = "Slack";
  readonly description = "Connect Slack DMs to a Radioso answering agent.";

  private initialized = false;

  constructor(private readonly options: SlackPluginOptions) {}

  configSchema(): ConfigFieldDefinition[] {
    return [];
  }

  async migrate(): Promise<void> {
    // Slack tables are created by numbered backend migration 107.
  }

  async initialize(context: ConnectorContext): Promise<void> {
    if (this.initialized) {
      return;
    }
    const db = context.db as never;
    const oauthConnections = new OauthConnectionRepository(db);
    const integrationConnections = new IntegrationConnectionRepository(db);
    const installations = new SlackInstallationRepository(context.db);
    const bindings = new SlackChannelBindingRepository(context.db);
    const persistence = new PostgresSlackPersistence(context.db);
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      encryptionKey: this.options.encryptionKey,
    });
    const messageHandler = new SlackMessageHandler({
      logger: context.logger,
      chat: context.chat,
      installations,
      bindings,
      installationService,
      persistence,
      clientFactory: this.options.clientFactory as ((options: { botToken: string }) => Pick<SlackWebApiClient, "postMessage">) | undefined,
    });

    context.http.mount(
      "/events",
      createSlackWebhookRouter({
        logger: context.logger,
        signingSecret: this.options.signingSecret,
        installations,
        persistence,
        messageHandler,
      }),
    );
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  getWebhookPath(): string {
    return "/api/connectors/slack/events";
  }

  uniqueChannelField(): string | null {
    return null;
  }

  validateConfig(): ConnectorValidationIssue[] {
    return [];
  }
}
