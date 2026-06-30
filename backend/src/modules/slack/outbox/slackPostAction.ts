import { z } from "zod";

import type { ActionHandler, ActionHandlerContext } from "../../chat/contracts/index.js";
import {
  SlackInstallationRepository,
  SlackInstallationService,
  SlackWebApiClient,
  postSlackText,
  PostgresWorkspaceAccountLookup,
  slackAuthErrorCode,
  type SlackInstallationRecord,
  type SlackWebApiClientOptions,
  type SlackWebApiClient as SlackWebApiClientInstance,
} from "../public.js";
import { OauthConnectionRepository } from "../../../db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../integrationConnections/public.js";
import type { Database } from "../../../shared/infra/database.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

export const SLACK_POST_ACTION_TYPE = "slack.post";
const MAX_SLACK_POST_ACTION_TEXT_LENGTH = 200_000;

export const slackPostPayloadSchema = z.object({
  installationId: z.string().uuid(),
  channelId: z.string().min(1),
  text: z.string().min(1).max(MAX_SLACK_POST_ACTION_TEXT_LENGTH),
  blocks: z.array(z.record(z.unknown())).optional(),
  threadTs: z.string().min(1).optional(),
  conversationRef: z.string().min(1).optional(),
  kind: z.enum(["gap_escalation", "routine_post", "operator_notification", "human_reply"]),
  updateTs: z.string().min(1).optional(),
});

export type SlackPostPayload = z.infer<typeof slackPostPayloadSchema>;

export interface SlackPostOutboxPort {
  enqueue(input: {
    type: string;
    payload: Record<string, unknown>;
    workspaceId?: string | null;
    accountId?: string | null;
    conversationId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ id: string; duplicate: boolean }>;
}

export const slackPostIdempotencyKey = (input: {
  kind: SlackPostPayload["kind"];
  sourceId: string;
}): string => `slack:${input.kind}:${input.sourceId}`;

export const enqueueSlackPostAction = async (
  outbox: SlackPostOutboxPort,
  input: {
    workspaceId: string;
    conversationId?: string | null;
    idempotencyKey: string;
    payload: SlackPostPayload;
  },
): Promise<{ id: string; duplicate: boolean }> =>
  outbox.enqueue({
    type: SLACK_POST_ACTION_TYPE,
    payload: input.payload,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId ?? input.payload.conversationRef ?? null,
    idempotencyKey: input.idempotencyKey,
  });

export type SlackPostClientFactory = (
  options: Pick<SlackWebApiClientOptions, "botToken">,
) => Pick<SlackWebApiClientInstance, "postMessage"> & Partial<Pick<SlackWebApiClientInstance, "updateMessage">>;

export interface SlackPostCredentialResolver {
  findInstallationById(installationId: string): Promise<SlackInstallationRecord | null>;
  markNeedsReauthForInstallation(installation: SlackInstallationRecord, errorCode: string): Promise<boolean>;
  resolveBotTokenForInstallation(installation: SlackInstallationRecord): Promise<string | null>;
}

export class SlackPostActionHandler implements ActionHandler {
  private readonly clientFactory: SlackPostClientFactory;

  constructor(private readonly options: {
    credentials: SlackPostCredentialResolver;
    clientFactory?: SlackPostClientFactory;
    logger?: Pick<AppLogger, "info" | "warn">;
  }) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new SlackWebApiClient(clientOptions));
  }

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const payload = slackPostPayloadSchema.parse(input.payload);
    const installation = await this.options.credentials.findInstallationById(payload.installationId);
    if (!installation) {
      throw new Error("slack_installation_not_found");
    }
    if (!input.context.accountId || installation.accountId !== input.context.accountId) {
      throw new Error("slack_installation_account_mismatch");
    }
    const botToken = await this.options.credentials.resolveBotTokenForInstallation(installation);
    if (!botToken) {
      await this.options.credentials.markNeedsReauthForInstallation(installation, "slack_bot_token_not_found");
      throw new Error("slack_bot_token_not_found");
    }
    try {
      const client = this.clientFactory({ botToken });
      if (payload.updateTs) {
        if (!client.updateMessage) {
          throw new Error("slack_update_message_unavailable");
        }
        await client.updateMessage({
          channel: payload.channelId,
          ts: payload.updateTs,
          text: payload.text,
          ...(payload.blocks ? { blocks: payload.blocks } : {}),
        });
      } else if (payload.blocks) {
        await client.postMessage({
          channel: payload.channelId,
          text: payload.text,
          ...(payload.threadTs ? { threadTs: payload.threadTs } : {}),
          blocks: payload.blocks,
        });
      } else {
        await postSlackText(client, {
          channel: payload.channelId,
          text: payload.text,
          ...(payload.threadTs ? { threadTs: payload.threadTs } : {}),
        });
      }
    } catch (error) {
      const authErrorCode = slackAuthErrorCode(error);
      if (authErrorCode) {
        await this.options.credentials.markNeedsReauthForInstallation(installation, authErrorCode);
      }
      throw error;
    }
    this.options.logger?.info?.({
      event: "slack_post",
      workspaceId: input.context.workspaceId,
      installationId: payload.installationId,
      kind: payload.kind,
      conversationRef: payload.conversationRef ?? null,
    }, "Slack post action delivered");
  }

  async recordFailureOutcome(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: "retry" | "failed";
    error: string;
  }): Promise<void> {
    const parsed = slackPostPayloadSchema.safeParse(input.payload);
    this.options.logger?.warn?.({
      event: "slack_post",
      workspaceId: input.context.workspaceId,
      installationId: parsed.success ? parsed.data.installationId : undefined,
      kind: parsed.success ? parsed.data.kind : undefined,
      outcome: input.outcome,
      error: input.error,
    }, "Slack post action failed");
  }
}

export class SlackPostActionCredentialResolver implements SlackPostCredentialResolver {
  private readonly installations: SlackInstallationRepository;
  private readonly installationService: SlackInstallationService;

  constructor(input: {
    database: Database;
    encryptionKey?: string;
  }) {
    const oauthConnections = new OauthConnectionRepository(input.database.kysely);
    const integrationConnections = new IntegrationConnectionRepository(input.database.kysely);
    this.installations = new SlackInstallationRepository(input.database.kysely);
    this.installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations: this.installations,
      bindings: {
        async findByInstallationId() {
          return null;
        },
        async findAnswerer() {
          return null;
        },
        async upsert() {
          throw new Error("slack_binding_upsert_unavailable");
        },
        async removeByInstallationId() {
          return false;
        },
      },
      workspaceAccounts: new PostgresWorkspaceAccountLookup(input.database.kysely),
      encryptionKey: input.encryptionKey,
    });
  }

  async findInstallationById(installationId: string): Promise<SlackInstallationRecord | null> {
    return this.installations.findById(installationId);
  }

  async markNeedsReauthForInstallation(installation: SlackInstallationRecord, errorCode: string): Promise<boolean> {
    return this.installationService.markNeedsReauthForInstallation(installation, errorCode);
  }

  async resolveBotTokenForInstallation(installation: SlackInstallationRecord): Promise<string | null> {
    return this.installationService.resolveBotTokenForInstallation(installation);
  }
}
