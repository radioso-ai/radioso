import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import { OauthConnectionRepository } from "../../../../db/repositories/oauthConnectionRepository.js";
import { ActionRequestRepository } from "../../../../db/repositories/actionRequestRepository.js";
import { PendingDecisionRepository } from "../../../../db/repositories/pendingDecisionRepository.js";
import type { ApprovalDecisionService } from "../../../approvals/public.js";
import type { AuditPort } from "../../../audit/contracts/index.js";
import { ConversationOwnershipRepository, type OperatorReplyService } from "../../../handoff/public.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { IntegrationConnectionRepository } from "../../../integrationConnections/public.js";
import {
  createSlackInteractivityRouter,
  FetchSlackResponseUrlClient,
  PostgresSlackOperatorPermission,
  PostgresWorkspaceMemberLookup,
  SlackChannelBindingRepository,
  SlackInstallationRepository,
  SlackInstallationService,
  SlackInteractivityHandler,
  SlackOperatorIdentityResolver,
  SlackWebApiClient,
} from "../../../slack/public.js";
import { SlackMessageHandler, type SlackWebApiClientFactory } from "./slackMessageHandler.js";
import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { PostgresSlackPersistence } from "./slackPersistence.js";
import { createSlackWebhookRouter } from "./slackWebhook.js";

export interface SlackPluginOptions {
  signingSecret: string;
  encryptionKey?: string;
  clientFactory?: SlackWebApiClientFactory;
}

type SlackConnectorContext = ConnectorContext & {
  approvalDecisionService?: Pick<ApprovalDecisionService, "resolve">;
  operatorReplyService?: Pick<OperatorReplyService, "reply">;
  auditService?: Pick<AuditPort, "record">;
  metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
  assertPublicUrl?: (url: string) => Promise<void>;
};

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
    const db = connectorKyselyDb(context.db);
    const oauthConnections = new OauthConnectionRepository(db);
    const integrationConnections = new IntegrationConnectionRepository(db);
    const installations = new SlackInstallationRepository(db);
    const bindings = new SlackChannelBindingRepository(db);
    const persistence = new PostgresSlackPersistence(db);
    const staleFailures = await persistence.markStaleInboundEventsFailed({
      olderThan: new Date(Date.now() - 10 * 60 * 1000),
    });
    if (staleFailures > 0) {
      context.logger.warn(
        { event: "slack_inbound", staleFailures },
        "Marked stale Slack inbound events failed during connector startup",
      );
    }
    const slackPostOutbox = new ActionRequestRepository(db);
    const extendedContext = context as SlackConnectorContext;
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      encryptionKey: this.options.encryptionKey,
    });
    const operatorIdentityResolver = new SlackOperatorIdentityResolver({
      workspaceMembers: new PostgresWorkspaceMemberLookup(db),
      permissions: new PostgresSlackOperatorPermission(db),
      slack: {
        usersInfo: async (slackUserId, installation) => {
          if (!installation) {
            throw new Error("slack_installation_required");
          }
          const botToken = await installationService.resolveBotTokenForInstallation(installation);
          if (!botToken) {
            throw new Error("slack_bot_token_not_found");
          }
          return new SlackWebApiClient({ botToken }).usersInfo(slackUserId);
        },
      },
    });
    const messageHandler = new SlackMessageHandler({
      logger: context.logger,
      chat: context.chat,
      installations,
      bindings,
      installationService,
      persistence,
      slackPostOutbox,
      clientFactory: this.options.clientFactory,
    });

    context.http.mount(
      "/",
      createSlackWebhookRouter({
        logger: context.logger,
        signingSecret: this.options.signingSecret,
        installations,
        persistence,
        messageHandler,
      }),
    );
    context.http.mount(
      "/",
      createSlackInteractivityRouter({
        logger: context.logger,
        signingSecret: this.options.signingSecret,
        handler: new SlackInteractivityHandler({
          installations,
          identityResolver: operatorIdentityResolver,
          approvalDecisions: extendedContext.approvalDecisionService,
          pendingDecisions: new PendingDecisionRepository(db),
          conversationOwnership: new ConversationOwnershipRepository(db),
          operatorReplyService: extendedContext.operatorReplyService,
          slackViews: {
            open: async ({ installation, triggerId, view }) => {
              const botToken = await installationService.resolveBotTokenForInstallation(installation);
              if (!botToken) {
                throw new Error("slack_bot_token_not_found");
              }
              await new SlackWebApiClient({ botToken }).viewsOpen({ triggerId, view });
            },
          },
          responseUrlClient: new FetchSlackResponseUrlClient({
            assertPublicUrl: extendedContext.assertPublicUrl,
          }),
          audit: extendedContext.auditService,
          metrics: extendedContext.metricsRegistry ?? undefined,
          logger: context.logger,
        }),
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
