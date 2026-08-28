import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import { createDefaultConnectorRegistry, type ApplicationComposition } from "../../composition/index.js";
import {
  WorkspaceProviderCredentialsService,
} from "../../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WebhookSkillDefinitionRepository } from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import { OauthConnectionRepository } from "../../../db/repositories/oauthConnectionRepository.js";
import {
  DefaultWebhookDestinationAdapter,
  WebhookDestinationService,
  type WebhookDestinationPublicAdapter,
  type WebhookDestinationRepositoryPort,
  type WebhookDestinationRoutineReferencePort,
} from "../../../modules/webhooks/public.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../../modules/settings/composition.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../../modules/settings/composition.js";
import { WorkspaceLlmCapabilityResolver } from "../../composition/workspaceLlmCapabilityResolver.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";
import {
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../../modules/customerEmail/public.js";
import { resolveLlmConfig } from "../../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import { AgentSkillRepository } from "../../../modules/agentSkills/public.js";
import { type AppLogger } from "../../../shared/observability/logger.js";
import type { Env } from "../../config/env.js";
import { buildInfrastructure, buildRepositories } from "./infra.js";
import { McpConnectionService } from "../../../modules/externalSkills/services/mcpConnectionService.js";
import {
  ExternalSkillDefinitionService,
} from "../../../modules/externalSkills/services/externalSkillDefinitionService.js";
import { createMcpToolServiceFactory } from "../../../modules/externalSkills/composition.js";
import { McpConnectionRepository } from "../../../db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../../db/repositories/externalSkillDefinitionRepository.js";
import { OauthConnectionService, StaticOauthProviderRegistry } from "../../../modules/integrationOauth/public.js";
import { CustomerEmailConnectionService, CustomerEmailOAuthService } from "../../../modules/customerEmail/public.js";
import {
  SlackInstallationService,
  PostgresWorkspaceAccountLookup,
  type SlackOauthMetadata,
} from "../../../modules/slack/public.js";
import { WebhookSkillDefinitionService } from "../../../modules/webhookSkills/public.js";
import { SlackSkillDefinitionService } from "../../../modules/slackSkills/public.js";
import { AgentSkillsService } from "../../../modules/agentSkills/public.js";
import {
  createDefaultSkillCapabilityRegistry,
  RoutineInvocableSkillNamesService,
} from "../../../modules/skills/public.js";
import { EmailSkillDefinitionService } from "../../../modules/customerEmail/public.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../../modules/documents/contracts/index.js";
import { MCP_OAUTH_CALLBACK_PATH } from "../../../modules/externalSkills/domain.js";
import { fetchPublicUrl } from "../../../shared/infra/http/publicUrlFetch.js";




export const buildWebhookDestinationAdapter = (input: {
  auditService: AuditPort;
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY" | "NODE_ENV" | "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK">;
  logger: Pick<AppLogger, "warn">;
  repositories: {
    webhookDestinationRepository: WebhookDestinationRepositoryPort;
    routineDefinitionRepository: WebhookDestinationRoutineReferencePort;
    webhookSkillDefinitionRepository?: Pick<WebhookSkillDefinitionRepository, "listSkillNamesByDestination">;
  };
  assertPublicUrl: (url: string) => Promise<void>;
}): WebhookDestinationPublicAdapter =>
  new DefaultWebhookDestinationAdapter(new WebhookDestinationService({
    repository: input.repositories.webhookDestinationRepository,
    auditService: input.auditService,
    encryption: { key: input.env.CONNECTOR_ENCRYPTION_KEY },
    assertPublicUrl: input.assertPublicUrl,
    allowHttpLoopback: input.env.NODE_ENV !== "production" && input.env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK === true,
    routineReferences: input.repositories.routineDefinitionRepository,
    skillReferences: input.repositories.webhookSkillDefinitionRepository
      ? {
          async listAgentSkillNamesReferencingDestination(workspaceId, destinationId) {
            return input.repositories.webhookSkillDefinitionRepository!.listSkillNamesByDestination(workspaceId, destinationId);
          },
        }
      : undefined,
  }));

export const buildWorkspaceLlmCapabilitySettingsService = (input: {
  auditService: AuditPort;
  capabilityRepository: WorkspaceLlmCapabilityPreferencesRepositoryPort;
  logger?: Pick<AppLogger, "warn">;
}): WorkspaceLlmCapabilitySettingsService =>
  new WorkspaceLlmCapabilitySettingsService(
    input.capabilityRepository,
    input.auditService,
    input.logger,
  );

const envApiKeyMap = (env: Env): Partial<Record<LlmProviderName, string>> => ({
  openai: env.OPENAI_API_KEY,
  "openai-compatible": env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY,
  gemini: env.GEMINI_API_KEY,
  claude: env.ANTHROPIC_API_KEY,
});

export const buildLlmCapabilityResolver = (input: {
  env: Env;
  defaults: ReturnType<typeof resolveLlmConfig>;
  settings: WorkspaceLlmCapabilitySettingsService;
  credentials: WorkspaceProviderCredentialsService;
}): LlmCapabilityResolver => {
  const keys = envApiKeyMap(input.env);
  return new WorkspaceLlmCapabilityResolver({
    defaults: input.defaults,
    settings: {
      getPreference: (workspaceId, capability) => input.settings.getPreference(workspaceId, capability),
    },
    credentials: {
      getApiKey: (workspaceId, provider) => input.credentials.getApiKey(workspaceId, provider),
    },
    envKeys: {
      resolveEnvApiKey: (provider) => keys[provider],
    },
    envBaseUrls: {
      "openai-compatible": input.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  });
};

export const buildLlmRegistry = (
  env: Env,
  logger: AppLogger,
  options: { resolver?: LlmCapabilityResolver } = {},
): LlmProviderRegistry => {
  const llmRegistry = new LlmProviderRegistry(resolveLlmConfig(env), logger, { resolver: options.resolver });
  logger.info({ llmProviders: llmRegistry.describe() }, "Resolved LLM providers");
  return llmRegistry;
};

export const buildConnectorRegistry = (input: {
  composition: ApplicationComposition;
  env: Env;
  logger: AppLogger;
}) => {
  const connectorRegistry = createDefaultConnectorRegistry(input.composition.connectors, input.env);
  if (input.env.CONNECTOR_ENCRYPTION_KEY) {
    connectorRegistry.setEncryptionKey(input.env.CONNECTOR_ENCRYPTION_KEY);
  } else {
    input.logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving or rotating connector secrets.",
      },
      "Connector secret encryption is not configured; secret-field writes will be rejected until this is fixed",
    );
  }
  return connectorRegistry;
};

/** Builds OAuth-backed integrations and the shared agent-skill registry. */
export const buildIntegrationServices = (input: {
  assertPublicUrl: (url: string) => Promise<void>;
  composition: ApplicationComposition;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const slackInstallationService = new SlackInstallationService({
    oauthConnections: new OauthConnectionRepository(input.infrastructure.database.kysely),
    integrationConnections: input.repositories.integrationConnectionRepository,
    installations: input.repositories.slackInstallationRepository,
    bindings: input.repositories.slackChannelBindingRepository,
    workspaceAccounts: new PostgresWorkspaceAccountLookup(input.infrastructure.database.kysely),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
  });
  const oauthConnectionService = new OauthConnectionService({
    repository: new OauthConnectionRepository(input.infrastructure.database.kysely),
    providers: new StaticOauthProviderRegistry(input.composition.oauthProviders),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
    appBaseUrl: input.env.APP_BASE_URL,
    apiBaseUrl: input.env.CONNECTOR_PUBLIC_BASE_URL ?? input.env.APP_BASE_URL,
    assertPublicUrl: input.assertPublicUrl,
    fetchImpl: fetchPublicUrl,
    logger: input.logger,
    onAuthorized: async ({ connection, tokens, metadata }) => {
      if (connection.provider !== "slack") {
        return;
      }
      const slackMetadata = metadata as Partial<SlackOauthMetadata>;
      if (!slackMetadata.teamId || !slackMetadata.botUserId) {
        throw new Error("Slack OAuth metadata was missing team or bot identity");
      }
      await slackInstallationService.saveInstallation({
        workspaceId: connection.workspaceId,
        oauthConnectionId: connection.id,
        teamId: slackMetadata.teamId,
        teamName: slackMetadata.teamName ?? null,
        botUserId: slackMetadata.botUserId,
        botAccessToken: tokens.accessToken,
        grantedScopes: connection.grantedScopes,
      });
    },
  });
  const customerEmailOAuthService = new CustomerEmailOAuthService(oauthConnectionService);
  const customerEmailConnectionService = new CustomerEmailConnectionService({
    repository: input.repositories.customerEmailConnectionRepository,
    oauthConnections: oauthConnectionService,
    providers: new StaticCustomerEmailProviderRegistry(
      customerEmailOauthProviderIds.map((provider) => new MockCustomerEmailProviderAdapter(provider)),
    ),
  });
  const mcpConnectionRepository = new McpConnectionRepository(input.infrastructure.database.kysely);
  const externalSkillDefinitionRepository = new ExternalSkillDefinitionRepository(input.infrastructure.database.kysely);
  const mcpConnectionService = new McpConnectionService({
    repository: mcpConnectionRepository,
    toolServiceFactory: createMcpToolServiceFactory(input.assertPublicUrl, fetchPublicUrl),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
    assertPublicUrl: input.assertPublicUrl,
    fetchImpl: fetchPublicUrl,
    oauthRedirectUri: input.env.APP_BASE_URL
      ? `${input.env.APP_BASE_URL.replace(/\/$/, "")}${MCP_OAUTH_CALLBACK_PATH}`
      : undefined,
    logger: input.logger,
  });
  const externalSkillDefinitionService = new ExternalSkillDefinitionService(
    externalSkillDefinitionRepository,
    mcpConnectionService,
  );
  const emailSkillDefinitionService = new EmailSkillDefinitionService({
    repository: input.repositories.emailSkillDefinitionRepository,
    connections: input.repositories.customerEmailConnectionRepository,
  });
  const webhookDestinations = buildWebhookDestinationAdapter({
    auditService: input.infrastructure.auditService,
    env: input.env,
    logger: input.logger,
    repositories: input.repositories,
    assertPublicUrl: input.assertPublicUrl,
  });
  const webhookSkillDefinitionService = new WebhookSkillDefinitionService({
    repository: input.repositories.webhookSkillDefinitionRepository,
    destinations: webhookDestinations,
  });
  const slackSkillDefinitionService = new SlackSkillDefinitionService({
    repository: input.repositories.slackSkillDefinitionRepository,
    installations: input.repositories.slackInstallationRepository,
  });
  const skillCapabilityRegistry = createDefaultSkillCapabilityRegistry({
    mcp_tool: async ({ agentId }) =>
      (await mcpConnectionService.list(agentId)).map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        status: connection.status,
      })),
    email: async ({ workspaceId }) =>
      (await customerEmailConnectionService.list(workspaceId)).map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        status: connection.status,
      })),
    slack_post: async ({ workspaceId }) => {
      const status = await slackInstallationService.getStatus(workspaceId);
      return status.installationId
        ? [{ id: status.installationId, label: status.teamName ?? "Slack", status: status.status }]
        : [];
    },
    webhook_call: async ({ workspaceId }) =>
      (await webhookDestinations.list(workspaceId)).map((destination) => ({
        id: destination.id,
        label: destination.name,
        status: destination.lastDeliveryStatus ?? undefined,
      })),
    retrieve: async ({ workspaceId }) => {
      const [sources, manualDocumentCount] = await Promise.all([
        input.repositories.documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
        input.repositories.documentSourceRepository.countDocumentsWithoutSource(workspaceId),
      ]);
      return [
        ...sources.map((source) => ({
          id: source.id,
          label: source.name,
          status: source.lastSyncStatus ?? undefined,
        })),
        ...(manualDocumentCount > 0
          ? [{ id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, label: "Manually added documents", status: "available" }]
          : []),
      ];
    },
  });
  const agentSkillRepository = new AgentSkillRepository(input.infrastructure.database.kysely);
  const routineInvocableSkillNames = new RoutineInvocableSkillNamesService({ agentSkills: agentSkillRepository });
  const agentSkillsService = new AgentSkillsService({
    repository: agentSkillRepository,
    capabilities: skillCapabilityRegistry,
    logger: input.logger,
  });
  return {
    agentSkillRepository,
    agentSkillsService,
    customerEmailConnectionService,
    customerEmailOAuthService,
    emailSkillDefinitionService,
    externalSkillDefinitionRepository,
    externalSkillDefinitionService,
    mcpConnectionRepository,
    mcpConnectionService,
    oauthConnectionService,
    slackInstallationService,
    slackSkillDefinitionService,
    skillCapabilityRegistry,
    routineInvocableSkillNames,
    webhookDestinations,
    webhookSkillDefinitionService,
  };
};
