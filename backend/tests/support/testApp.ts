import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { createMailService } from "../../src/modules/mail/public.js";
import { randomUUID } from "node:crypto";
import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";
import type { DirectiveFiringState, DirectiveStateStore } from "../../src/modules/directives/public.js";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../src/modules/accessGrants/public.js";
import { AccountInvitationService } from "../../src/modules/account/services/accountInvitationService.js";
import { ApprovalDecisionService } from "../../src/modules/approvals/public.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { EmailVerificationService } from "../../src/modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../src/modules/auth/services/passwordResetService.js";
import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import {
  createRouteScopedDirectiveSteering,
  InMemoryConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  RoutineNextStepSelector,
  RoutineRegistry,
  RoutineStepRenderer,
  type RoutineRegistration,
  type WorkbenchReplayRunner,
} from "../../src/modules/chat/composition.js";
import { ChatService, type ChatGateway, type ChatRoutineProvider } from "../../src/modules/chat/services/chatService.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import { ActionDispatchWorker } from "../../src/modules/chat/services/actions/actionDispatchWorker.js";
import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import { scopeTag } from "@radioso/conversation-defaults";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { createSkillOutcomeCapabilityProvider } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { AssistantChatService } from "../../src/modules/chat/services/assistantChatService.js";
import { AssistantHistoryService } from "../../src/modules/chat/services/assistantHistoryService.js";
import { AgentService, AgentSurfaceExtensionRegistry, AuthoredDirectiveService, DirectiveAuthorService } from "../../src/modules/agents/public.js";
import { RoutineDefinitionService, RoutineDraftAssistService } from "../../src/modules/routines/public.js";
import {
  type ComposedDecline,
  type FallbackReplyComposer,
} from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import { ConversationForkService } from "../../src/modules/chat/services/conversationForkService.js";
import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { DocumentSearchHistoryService } from "../../src/modules/documents/services/documentSearchHistoryService.js";
import { DocumentSearchService } from "../../src/modules/documents/services/documentSearchService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
import { DocumentSourceReprocessService } from "../../src/modules/documents/services/documentSourceReprocessService.js";
import { WorkspaceIngestionReprocessService } from "../../src/modules/documents/services/workspaceIngestionReprocessService.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { RecursiveTextChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/recursiveTextChunkingStrategy.js";
import { StructuredSemanticChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";
import { ChonkieChunkingProvider } from "../../src/modules/retrieval/infra/chonkieChunkingProvider.js";
import type { LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { AttributeMatchScoringService } from "../../src/modules/retrieval/services/attributeMatchScoringService.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import {
  QueryRewriteService,
  type QueryRewriteGateway,
  type TriggerAnalysisGateway,
} from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService, type RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { RetrievalAnswerService } from "../../src/modules/retrieval/services/retrievalAnswerService.js";
import { RetrievalSearchService } from "../../src/modules/retrieval/services/retrievalSearchService.js";
import {
  EmbeddingGenerationService,
  type EmbeddingGenerationGateway,
} from "../../src/modules/embeddingProfiles/public.js";
import { streamResult, textResult } from "./llmStubs.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import type {
  EmbeddingModelTransitionPort,
  EmbeddingModelTransitionState,
} from "../../src/modules/settings/contracts/services.js";
import { PlatformSettingsService } from "../../src/modules/settings/services/platformSettingsService.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/public.js";
import type { QueryEmbeddingPort } from "../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import type { VectorCandidateSearchPort } from "../../src/modules/retrieval/domain/vectorAdapter.js";
import type { ChunkCandidateHydratorPort } from "../../src/modules/retrieval/infra/chunkCandidateHydrator.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { WorkspaceSummaryService } from "../../src/modules/workspace/services/workspaceSummaryService.js";
import { WorkspaceSessionService } from "../../src/modules/auth/services/workspaceSessionService.js";
import { ConnectorRegistry } from "../../src/modules/connectors/services/connectorRegistry.js";
import { ConnectorManagementService } from "../../src/modules/connectors/services/connectorManagementService.js";
import { createConnectorChatPort } from "../../src/modules/connectors/services/connectorChatPort.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { WorkspaceProviderCredentialsService } from "../../src/modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { McpConnectionService } from "../../src/modules/externalSkills/services/mcpConnectionService.js";
import { ExternalSkillDefinitionService } from "../../src/modules/externalSkills/services/externalSkillDefinitionService.js";
import { OauthConnectionService, StaticOauthProviderRegistry } from "../../src/modules/integrationOauth/public.js";
import {
  CustomerEmailConnectionService,
  CustomerEmailOAuthService,
  EmailSkillDefinitionService,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
} from "../../src/modules/customerEmail/public.js";
import { WebhookSkillDefinitionService } from "../../src/modules/webhookSkills/public.js";
import {
  SlackInstallationService,
  buildSlackOauthProviderDefinition,
  slackBotScopes,
  type SlackOauthMetadata,
} from "../../src/modules/slack/public.js";
import {
  InMemoryMcpConnectionRepository,
  InMemoryExternalSkillDefinitionRepository,
  createMockToolServiceFactory,
} from "./inMemoryExternalSkills.js";
import { InMemoryOauthConnectionRepository } from "./inMemoryOauthConnections.js";
import { InMemoryCustomerEmailConnectionRepository } from "./inMemoryCustomerEmailConnections.js";
import { InMemoryIntegrationConnectionRepository } from "./inMemoryIntegrationConnections.js";
import {
  InMemorySlackBindingRepository,
  InMemorySlackInstallationRepository,
} from "./inMemorySlack.js";
import { InMemoryEmailSkillDefinitionRepository } from "./inMemoryEmailSkillDefinitions.js";
import { InMemoryEmailSkillActivityRepository } from "./inMemoryEmailSkillActivity.js";
import { InMemoryWebhookSkillDefinitionRepository } from "./inMemoryWebhookSkillDefinitions.js";
import { InMemorySlackSkillDefinitionRepository } from "./inMemorySlackSkillDefinitions.js";
import { InMemoryAgentSkillRepository } from "./inMemoryAgentSkills.js";
import { SlackSkillDefinitionService } from "../../src/modules/slackSkills/public.js";
import { OperatorReplyService } from "../../src/modules/handoff/public.js";
import { AgentSkillsService } from "../../src/modules/agentSkills/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../src/modules/skills/capabilityRegistry.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../src/modules/documents/contracts/index.js";
import {
  DefaultWebhookDestinationAdapter,
  WebhookDestinationService,
} from "../../src/modules/webhooks/public.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../src/modules/settings/services/workspaceLlmCapabilitySettingsService.js";
import { buildAnalyticsSinks } from "../../src/shared/analytics/buildAnalyticsSinks.js";
import { ProductAnalyticsService } from "../../src/shared/analytics/productAnalyticsService.js";
import { buildErrorSinks } from "../../src/shared/errors/buildErrorSinks.js";
import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import {
  AgentTurnProbeService,
  OperatorCopilotService,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotProposal,
  type CopilotRepositoryPort,
} from "../../src/modules/operatorCopilot/public.js";
import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  TextRoutedToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";
import { createCopilotToolCatalog } from "../../src/app/composition/copilotToolCatalog.js";
import { createAgentSettingCopilotProposalAdapter, createDirectiveCopilotProposalAdapter, createRoutineCopilotProposalAdapter } from "../../src/app/composition/copilotProposalAdapters.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { buildTelemetrySinks } from "../../src/shared/observability/telemetry/buildTelemetrySinks.js";
import { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type {
  AgentContextVariableEnablementRecord,
  ContextVariableCreateRecord,
  ContextVariableRepositoryPort,
  ContextVariableUpdateRecord,
} from "../../src/db/repositories/contextVariableRepository.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableValue,
  ResolvedVariableInput,
} from "../../src/modules/context-variables/public.js";
import {
  EvalCaseService,
  EvalMessageCaseService,
  EvalRunService,
  EvalSuiteService,
  EvalSnapshotService,
} from "../../src/modules/eval/composition.js";
import { createInMemoryEvalRepository } from "./inMemoryEvalRepository.js";
import { ApplicationModuleCoordinator, createApplicationExtensionRegistry } from "../../src/app/composition/applicationModule.js";
import {
  createDefaultAgentSkillSettingsRegistry,
  createRetrievalSkillSettingsResolver,
  createSystemRetrievalDefaultsProvider,
} from "../../src/app/composition/index.js";
import { DefaultAllowCapabilityPolicy, registeredCapabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { NoopUsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import {
  noopOrganizationCreationGuard,
  type OrganizationCreationGuard,
} from "../../src/shared/domain/organizationCreationGuard.js";
import {
  ChainedPublicChatActionAdvertiser,
  NoopPublicChatActionAdvertiser,
  type PublicChatActionAdvertiserPort,
} from "../../src/modules/chat/services/publicChatActionAdvertiser.js";
import { InMemoryPublicConversationEventBus } from "../../src/modules/chat/composition.js";
import { NoopContactHistoryProvider, type ContactHistoryProviderPort } from "../../src/modules/chat/services/contactHistoryProvider.js";
import type { AnswerFeedbackHistoryProviderPort } from "../../src/modules/chat/services/answerFeedbackHistoryProvider.js";
import {
  createDefaultSkillCatalogRegistry,
  SkillAuthoringCatalogService,
  SkillCatalogService,
  SkillExecutorRegistry,
} from "../../src/modules/skills/public.js";
import type { AgentSkillTurnSkillProvider } from "../../src/modules/chat/services/agentSkillTurnSkillProvider.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../src/app/composition/builtIn/agentSkillTurnSkillProvider.js";
import type { ApplicationRouteMount } from "../../src/app/composition/applicationModule.js";
import type { AbuseControlRepositoryPort } from "../../src/db/repositories/abuseControlRepository.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryAccountRepository,
  InMemoryAccountInvitationRepository,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceGrantRepository,
  InMemoryWorkspaceTokenRepository,
  InMemoryChunkRepository,
  InMemoryConversationRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentSourceRepository,
  InMemoryDocumentStorage,
  InMemoryDocumentProcessingJobRepository,
  InMemoryIngestionSettingsRepository,
  InMemoryHistoryItemsRepository,
  InMemoryMessageRepository,
  InMemoryConversationOwnershipRepository,
  InMemoryRetrievalSettingsRepository,
  InMemorySessionRepository,
  InMemoryEmailVerificationTokenRepository,
  InMemoryPasswordResetTokenRepository,
  InMemoryWorkspaceRepository,
  InMemoryAgentRepository,
  InMemoryConnectorDatabase,
  InMemoryAbuseControlRepository,
  InMemoryAccessGrantRepository,
  InMemoryWorkspaceProviderCredentialsRepository,
  InMemoryWebhookDestinationRepository,
  InMemoryRoutineDefinitionRepository,
} from "./fakes.js";
import { InMemoryOrganizationProvisioner } from "./organizationProvisioner.js";
import {
  bindClusteringEmbeddingPort,
  bindDocumentEmbeddingPort,
} from "./embeddingPorts.js";

export const createTestEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8080,
  TRUST_PROXY_HOPS: 0,
  OBSERVABILITY_ENABLED: true,
  OBSERVABILITY_SERVICE_NAME: "radioso-api",
  OBSERVABILITY_ENVIRONMENT: "test",
  OBSERVABILITY_VERSION: "test",
  METRICS_ENABLED: false,
  METRICS_PATH: "/metrics",
  METRICS_AUTH_TOKEN: undefined,
  OTEL_ENABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_LOGS_ENABLED: false,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER: undefined,
  OTEL_LOGS_MIN_LEVEL: undefined,
  PRODUCT_ANALYTICS_SINKS: "audit",
  ERROR_SINKS: "audit",
  GOOGLE_CLOUD_PROJECT: "radioso-test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  DB_POOL_MAX: 10,
  DB_POOL_IDLE_TIMEOUT_MS: 30_000,
  DB_POOL_CONNECTION_TIMEOUT_MS: 5_000,
  DB_STATEMENT_TIMEOUT_MS: 15_000,
  DB_QUERY_TIMEOUT_MS: 20_000,
  DB_MIGRATION_LOCK_TIMEOUT_MS: 10_000,
  DB_MIGRATION_STATEMENT_TIMEOUT_MS: 25_000,
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5-mini",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_NAME: "radioso_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  WORKSPACE_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
  PUBLIC_CHAT_SESSION_SECRET: "00112233445566778899aabbccddeeff",
  RADIOSO_MCP_SIGNING_SECRET: "smoke-signing-secret",
  SESSION_TTL_HOURS: 168,
  AUTH_AUTO_VERIFY_EMAIL: false,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: 30,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS: 60_000,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: 60,
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
  PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 10,
  PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 600,
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: false,
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "test-document-imports",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  WORKER_DISPATCH_DRIVER: "noop",
  WORKER_TASKS_QUEUE_LOCATION: undefined,
  WORKER_TASKS_QUEUE_NAME: undefined,
  WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
  ACTION_DISPATCH_TASK_QUEUE_NAME: undefined,
  WORKER_TASKS_SERVICE_URL: undefined,
  WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
  WORKER_TASK_AUTH_TOKEN: undefined,
  WORKER_AMQP_URL: undefined,
  WORKER_AMQP_QUEUE_NAME: undefined,
  WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
  WORKER_AMQP_PREFETCH: 1,
  DOCUMENT_PROCESSING_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWL_JOB_LEASE_MS: 900_000,
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: 5_000,
  FACET_EXTRACTION_WORKER_POLL_INTERVAL_MS: 5_000,
  FACET_EXTRACTION_WORKER_BATCH_SIZE: 10,
  FACET_EXTRACTION_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWLER_ENABLED: true,
  APP_BASE_URL: undefined,
  SLACK_OAUTH_CLIENT_ID: undefined,
  SLACK_OAUTH_CLIENT_SECRET: undefined,
  SLACK_SIGNING_SECRET: undefined,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  RADIOSO_BASE_URL: undefined,
  RADIOSO_MCP_ENABLED: false,
  RADIOSO_MCP_STANDALONE: false,
  RADIOSO_MCP_MOUNT_PATH: "/mcp",
  RADIOSO_MCP_MERGED_CORS_ORIGINS: "*",
  RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS: 900,
  RADIOSO_MCP_ALLOWED_READ_TOOLS: undefined,
  RADIOSO_MCP_ALLOWED_WRITE_TOOLS: undefined,
  RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: undefined,
  RADIOSO_MCP_AUDIT_LOG_PATH: undefined,
  RADIOSO_MCP_BIND_HOST: "127.0.0.1",
  RADIOSO_MCP_BIND_PORT: 8787,
  RADIOSO_MCP_REDIS_KEY_PREFIX: "radioso-mcp",
  RADIOSO_MCP_REDIS_URL: undefined,
  RADIOSO_MCP_REQUEST_TIMEOUT_MS: 30_000,
  RADIOSO_MCP_SERVER_NAME: "radioso-context",
  RADIOSO_MCP_WORKSPACE_POLICIES_PATH: undefined,
  RADIOSO_EDITION: "oss",
  RADIOSO_APPLICATION_MODULES: undefined,
});

interface TestRepositories {
  auditEventRepository: InMemoryAuditEventRepository;
  accessGrantRepository: InMemoryAccessGrantRepository;
  userRepository: InMemoryUserRepository;
  ingestionSettingsRepository: InMemoryIngestionSettingsRepository;
  retrievalSettingsRepository: InMemoryRetrievalSettingsRepository;
  documentRepository: InMemoryDocumentRepository;
  documentSourceRepository: InMemoryDocumentSourceRepository;
  chunkRepository: InMemoryChunkRepository;
  documentProcessingJobRepository: InMemoryDocumentProcessingJobRepository;
  conversationRepository: InMemoryConversationRepository;
  conversationOwnershipRepository: InMemoryConversationOwnershipRepository;
  messageRepository: InMemoryMessageRepository;
  agentRepository: InMemoryAgentRepository;
  agentSkillRepository: InMemoryAgentSkillRepository;
  routineDefinitionRepository: InMemoryRoutineDefinitionRepository;
}

const appDependencyMap = new WeakMap<object, AppDependencies>();
const appRepositoryMap = new WeakMap<object, TestRepositories>();

class TestFallbackReplyComposer implements FallbackReplyComposer {
  async composeNoContext(): Promise<ComposedDecline> {
    return {
      text: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
      declineReason: "content_gap",
    };
  }
}

class InMemoryRoutineStateStore implements ConversationRoutineStore {
  readonly states = new Map<string, RoutineState>();

  async loadActive({ sessionId }: { sessionId: string }): Promise<RoutineState | null> {
    return this.states.get(sessionId) ?? null;
  }

  async save(state: RoutineState): Promise<void> {
    this.states.set(state.sessionId, state);
  }

  async clear({ sessionId }: { sessionId: string }): Promise<void> {
    this.states.delete(sessionId);
  }
}

class InMemoryDirectiveStateStore implements DirectiveStateStore {
  readonly states = new Map<string, DirectiveFiringState>();

  async load({ sessionId }: { sessionId: string }): Promise<DirectiveFiringState | null> {
    const state = this.states.get(sessionId);
    return state ? { turnSeq: state.turnSeq, firings: { ...state.firings } } : null;
  }

  async save({ sessionId, state }: { sessionId: string; state: DirectiveFiringState }): Promise<void> {
    this.states.set(sessionId, { turnSeq: state.turnSeq, firings: { ...state.firings } });
  }
}

class InMemoryContextVariableRepository implements ContextVariableRepositoryPort {
  readonly variables = new Map<string, ContextVariable>();
  readonly enablements = new Map<string, AgentContextVariableEnablement>();
  readonly values = new Map<string, ContextVariableValue>();

  async create(input: ContextVariableCreateRecord): Promise<ContextVariable> {
    const now = new Date();
    const variable: ContextVariable = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      valueType: input.valueType,
      trustTier: input.trustTier,
      sensitivity: input.sensitivity,
      defaultSurfacing: input.defaultSurfacing,
      createdAt: now,
      updatedAt: now,
    };
    this.variables.set(variable.id, variable);
    return variable;
  }

  async update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null> {
    const current = await this.get(workspaceId, id);
    if (!current) {
      return null;
    }
    const updated: ContextVariable = {
      ...current,
      ...input,
      description: "description" in input ? input.description ?? null : current.description,
      updatedAt: new Date(),
    };
    this.variables.set(id, updated);
    return updated;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const current = await this.get(workspaceId, id);
    if (!current) {
      return false;
    }
    this.variables.delete(id);
    for (const key of this.enablements.keys()) {
      if (key.endsWith(`:${id}`)) {
        this.enablements.delete(key);
      }
    }
    for (const key of this.values.keys()) {
      if (key.startsWith(`${id}:`)) {
        this.values.delete(key);
      }
    }
    return true;
  }

  async listByWorkspace(workspaceId: string): Promise<ContextVariable[]> {
    return [...this.variables.values()]
      .filter((variable) => variable.workspaceId === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(workspaceId: string, id: string): Promise<ContextVariable | null> {
    const variable = this.variables.get(id);
    return variable && variable.workspaceId === workspaceId ? variable : null;
  }

  async upsertEnablement(input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement> {
    const key = this.enablementKey(input.agentId, input.variableId);
    const existing = this.enablements.get(key);
    const now = new Date();
    const enablement: AgentContextVariableEnablement = {
      id: existing?.id ?? randomUUID(),
      agentId: input.agentId,
      variableId: input.variableId,
      source: input.source,
      resolverSkillId: input.resolverSkillId ?? null,
      maxAgeSeconds: input.maxAgeSeconds ?? null,
      resolverTimeoutMs: input.resolverTimeoutMs ?? null,
      surfacing: input.surfacing,
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.enablements.set(key, enablement);
    return enablement;
  }

  async deleteEnablement(agentId: string, variableId: string): Promise<boolean> {
    return this.enablements.delete(this.enablementKey(agentId, variableId));
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]> {
    return [...this.enablements.values()]
      .filter((enablement) => enablement.agentId === agentId)
      .map((enablement) => ({
        ...enablement,
        variable: this.variables.get(enablement.variableId),
      }))
      .filter((enablement) => enablement.variable?.workspaceId === workspaceId)
      .sort((left, right) => (left.variable?.name ?? "").localeCompare(right.variable?.name ?? ""));
  }

  async upsertValue(variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue> {
    const variable = this.variables.get(variableId);
    if (!variable) {
      throw new Error(`Context variable ${variableId} not found`);
    }
    const key = this.valueKey(variableId, scope);
    const existing = this.values.get(key);
    const value: ContextVariableValue = {
      id: existing?.id ?? randomUUID(),
      workspaceId: variable.workspaceId,
      variableId,
      scope,
      data,
      lastModified: new Date(),
    };
    this.values.set(key, value);
    return value;
  }

  async readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null> {
    return this.values.get(this.valueKey(variableId, scope)) ?? null;
  }

  async deleteValue(variableId: string, scope: ContextVariableScope): Promise<boolean> {
    return this.values.delete(this.valueKey(variableId, scope));
  }

  async resolveForAgent(): Promise<ResolvedVariableInput[]> {
    return [];
  }

  private enablementKey(agentId: string, variableId: string): string {
    return `${agentId}:${variableId}`;
  }

  private valueKey(variableId: string, scope: ContextVariableScope): string {
    return `${variableId}:${scope.type}:${scope.id}`;
  }
}

export const createTestDependencies = (overrides: {
  chatGateway?: ChatGateway;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  turnRouter?: TurnRouter;
  triggerAnalysisGateway?: TriggerAnalysisGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  fallbackReplyComposer?: FallbackReplyComposer;
  usageLimitPolicy?: UsageLimitPolicy;
  organizationCreationGuard?: OrganizationCreationGuard;
  answerFeedbackHistoryProvider?: AnswerFeedbackHistoryProviderPort;
  contactHistoryProvider?: ContactHistoryProviderPort;
  publicChatActionAdvertiser?: PublicChatActionAdvertiserPort;
  applicationRouteMounts?: ApplicationRouteMount[];
  workbenchReplayRunner?: Pick<WorkbenchReplayRunner, "run">;
  chatInferencePipelineComplete?: AppDependencies["chatInferencePipeline"]["complete"];
  logger?: AppDependencies["logger"];
  skillExecutorRegistry?: SkillExecutorRegistry;
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
} = {}): { dependencies: AppDependencies; repositories: TestRepositories; routineStateStore: InMemoryRoutineStateStore; directiveStateStore: InMemoryDirectiveStateStore } => {
  const env = {
    ...createTestEnv(),
    ...overrides.envOverrides,
  } satisfies Env;
  const logger = overrides.logger ?? createLogger("silent");
  const { metricsRegistry, sinks: telemetrySinks } = buildTelemetrySinks(env);
  const telemetryService = new TelemetryService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    sinks: telemetrySinks,
    version: env.OBSERVABILITY_VERSION,
  });
  const auditEventRepository = new InMemoryAuditEventRepository();
  const accessGrantRepository = new InMemoryAccessGrantRepository();
  const auditService = createAuditService(auditEventRepository);
  const productAnalyticsService = new ProductAnalyticsService({
    enabled: env.OBSERVABILITY_ENABLED,
    logger,
    sinks: buildAnalyticsSinks({
      auditService,
      env,
      metricsRegistry,
    }),
  });
  const usageLimitPolicy = overrides.usageLimitPolicy ?? new NoopUsageLimitPolicy();
  const usageEventRecorder = new NoopUsageEventRecorder();
  const organizationCreationGuard = overrides.organizationCreationGuard ?? noopOrganizationCreationGuard;
  const persistentErrorReportingService = new ErrorReportingService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    version: env.OBSERVABILITY_VERSION,
    sinks: buildErrorSinks({
      auditService,
      env,
      metricsRegistry,
    }),
  });
  const accountRepository = new InMemoryAccountRepository();
  const userRepository = new InMemoryUserRepository();
  const accountMembershipRepository = new InMemoryAccountMembershipRepository();
  accountMembershipRepository.setUserRepository(userRepository);
  const workspaceRepository = new InMemoryWorkspaceRepository();
  const workspaceGrantRepository = new InMemoryWorkspaceGrantRepository();
  const accountAccessService = new AccountAccessService(
    accountMembershipRepository,
    auditService,
    workspaceGrantRepository,
    workspaceRepository,
  );
  const accountInvitationService = new AccountInvitationService(
    new InMemoryAccountInvitationRepository(),
    userRepository,
    accountAccessService,
    auditService,
  );
  const sessionRepository = new InMemorySessionRepository();
  const workspaceTokenRepository = new InMemoryWorkspaceTokenRepository();
  const ingestionSettingsRepository = new InMemoryIngestionSettingsRepository();
  const retrievalSettingsRepository = new InMemoryRetrievalSettingsRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const documentSourceRepository = new InMemoryDocumentSourceRepository();
  documentSourceRepository.setDocumentRepository(documentRepository);
  const documentProcessingJobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(documentProcessingJobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const documentStorage = new InMemoryDocumentStorage();
  const conversationRepository = new InMemoryConversationRepository();
  const conversationOwnershipRepository = new InMemoryConversationOwnershipRepository();
  conversationRepository.setOwnershipReader(conversationOwnershipRepository);
  const messageRepository = new InMemoryMessageRepository();
  conversationRepository.setMessageRepository(messageRepository);
  const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
  const embeddingGateway: EmbeddingGenerationGateway = {
    async embedTexts(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [text.length, text.split(" ").length, 1]);
    },
  };
  const vectorSearch: VectorSearchPort = {
    async search(input): Promise<RetrievedChunk[]> {
      const queryTerms = new Set(
        input.queryEmbedding.length > 0
          ? []
          : [],
      );
      void queryTerms;
      const rows: RetrievedChunk[] = [];
      for (const [documentId, chunks] of chunkRepository.items.entries()) {
        const document = documentRepository.items.get(documentId);
        if (!document || document.workspaceId !== input.workspaceId || document.status !== "ready") {
          continue;
        }
        if (input.sourceFilter?.constrained && (!document.sourceId || !input.sourceFilter.sourceIds.includes(document.sourceId))) {
          continue;
        }
        for (const chunk of chunks) {
          const score = keywordScore(`${document.title} ${chunk.content}`, currentQueryText);
          if (score >= input.similarityThreshold) {
            rows.push({
              chunkId: chunk.id,
              documentId,
              title: document.title,
              content: chunk.content,
              similarity: score,
              chunkIndex: chunk.chunkIndex,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset,
              metadata: chunk.metadata ?? document.metadata,
            });
          }
        }
      }
      return rows.sort((a, b) => b.similarity - a.similarity).slice(0, input.topK);
    },
  };
  const defaultLexicalSearch: LexicalSearchPort = {
    async search(input): Promise<RetrievedChunk[]> {
      const rows: RetrievedChunk[] = [];
      for (const [documentId, chunks] of chunkRepository.items.entries()) {
        const document = documentRepository.items.get(documentId);
        if (!document || document.workspaceId !== input.workspaceId || document.status !== "ready") {
          continue;
        }
        if (input.sourceFilter?.constrained && (!document.sourceId || !input.sourceFilter.sourceIds.includes(document.sourceId))) {
          continue;
        }
        for (const chunk of chunks) {
          const haystack = `${document.title} ${chunk.searchText ?? chunk.content}`;
          if (!keywordAllTermsMatch(haystack, input.query)) {
            continue;
          }
          const score = keywordScore(haystack, input.query);
          if (score > 0) {
            rows.push({
              chunkId: chunk.id,
              documentId,
              title: document.title,
              content: chunk.content,
              similarity: score,
              chunkIndex: chunk.chunkIndex,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset,
              metadata: chunk.metadata ?? document.metadata,
            });
          }
        }
      }
      return rows.sort((a, b) => b.similarity - a.similarity).slice(0, input.topK);
    },
  };
  const lexicalSearch = overrides.lexicalSearch ?? defaultLexicalSearch;
  let currentQueryText = "";
  const embeddingService = new EmbeddingGenerationService({
    async embedTexts(texts: string[]): Promise<number[][]> {
      currentQueryText = texts[0] ?? "";
      return embeddingGateway.embedTexts(texts);
    },
  });
  const queryEmbeddings: QueryEmbeddingPort = {
    async embedQueries(request) {
      const vectors = await embeddingService.embedTexts([...request.texts], {
        usageContext: request.usageContext,
      });
      return {
        space: {
          id: "test-space",
          dimensions: vectors[0]?.length ?? 0,
          distanceMetric: "cosine",
        },
        vectors,
      };
    },
  };
  let hydratedVectorRows = new Map<string, RetrievedChunk>();
  const vectorCandidates: VectorCandidateSearchPort = {
    async search(input) {
      const rows = await vectorSearch.search({
        workspaceId: input.workspaceId,
        queryEmbedding: input.queryVector,
        topK: input.topK,
        similarityThreshold: input.minimumScore,
        metadataFilter: input.filter.metadataContains,
        sourceFilter: input.filter.source,
      });
      hydratedVectorRows = new Map(rows.map((row) => [row.chunkId, row]));
      return rows.map((row) => ({
        chunkId: row.chunkId,
        documentId: row.documentId,
        embeddingSpaceId: input.space.id,
        version: "0",
        score: row.similarity,
      }));
    },
  };
  const chunkHydrator: ChunkCandidateHydratorPort = {
    async hydrate({ candidates }) {
      return candidates.flatMap((candidate) => {
        const row = hydratedVectorRows.get(candidate.chunkId);
        return row ? [row] : [];
      });
    },
  };
  const chunkingProvider = new ChonkieChunkingProvider(
    bindClusteringEmbeddingPort(embeddingService),
  );
  const chunkingStrategyRegistry = new ChunkingStrategyRegistry([
    new FixedWindowChunkingStrategy(chunkingProvider),
    new StructuredSemanticChunkingStrategy(chunkingProvider),
    new RecursiveTextChunkingStrategy(chunkingProvider),
  ]);
  const defaultQueryRewriteGateway: QueryRewriteGateway = {
    async rewrite(input) {
      const lastUserContext =
        [...input.contextMessages].reverse().find((message) => message.role === "user")?.content ?? "";
      const normalizedContext = normalizeRewriteContext(lastUserContext);

      if (/used for/i.test(input.query) && normalizedContext.length > 0) {
        return {
          rewrittenQuery: `${normalizedContext} used for`.trim(),
          turnKind: "referential_followup",
          proposedActiveSubject: normalizedContext,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.95,
        };
      }

      if (/who is it for/i.test(input.query) && normalizedContext.length > 0) {
        return {
          rewrittenQuery: `${normalizedContext} audience`.trim(),
          turnKind: "referential_followup",
          proposedActiveSubject: normalizedContext,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        };
      }

      if (/work with/i.test(input.query) && normalizedContext.length > 0) {
        return {
          rewrittenQuery: input.query.trim(),
          turnKind: "referential_relation",
          proposedActiveSubject: normalizedContext,
          relatedEntities: ["Arudra"],
          unresolved: true,
          confidence: 0.75,
        };
      }

      return {
        rewrittenQuery: `${lastUserContext} ${input.query}`.trim(),
        turnKind: "referential_followup",
        proposedActiveSubject: normalizedContext || undefined,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      };
    },
  };
  const queryRewriteGateway = overrides.queryRewriteGateway ?? defaultQueryRewriteGateway;
  const triggerAnalysisGateway = overrides.triggerAnalysisGateway;
  const defaultRerankGateway: RerankGateway = {
    async rerank(input) {
      return input.contexts.map((context) => ({
        chunkId: context.chunkId,
        relevanceScore: keywordScore(`${context.title} ${context.content}`, input.query),
      }));
    },
  };
  const rerankGateway = overrides.rerankGateway ?? defaultRerankGateway;
  const workspaceIngestionReprocessService = new WorkspaceIngestionReprocessService(documentRepository, auditService);
  const documentSourceReprocessService = new DocumentSourceReprocessService(
    documentRepository,
    documentSourceRepository,
    auditService,
  );
  const embeddingTransitionStates = new Map<
    string,
    EmbeddingModelTransitionState
  >();
  const embeddingTransitions: EmbeddingModelTransitionPort = {
    async getState(workspaceId) {
      return embeddingTransitionStates.get(workspaceId) ?? null;
    },
    async start({ workspaceId, activeModel, targetModel }) {
      const { documentCount } = await documentRepository.summarizeWorkspace(
        workspaceId,
      );
      const transition: EmbeddingModelTransitionState = documentCount > 0
        ? {
            activeModel,
            pendingModel: targetModel,
            status: "building",
            readiness: "building",
            failureReason: null,
          }
        : {
            activeModel: targetModel,
            pendingModel: null,
            status: "promoted",
            readiness: "ready",
            failureReason: null,
          };
      embeddingTransitionStates.set(workspaceId, transition);
      return transition;
    },
    async cancel(workspaceId) {
      const settings = await ingestionSettingsRepository.findByWorkspaceId(
        workspaceId,
      );
      const transition: EmbeddingModelTransitionState = {
        activeModel:
          settings?.embeddingModel ?? "text-embedding-3-small",
        pendingModel: null,
        status: "cancelled",
        readiness: null,
        failureReason: null,
      };
      embeddingTransitionStates.set(workspaceId, transition);
      return transition;
    },
    async reconcile(workspaceId) {
      return embeddingTransitionStates.get(workspaceId) ?? null;
    },
  };
  const ingestionSettingsService = new IngestionSettingsService(
    ingestionSettingsRepository,
    auditService,
    undefined,
    embeddingTransitions,
  );
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentProcessingService = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    bindDocumentEmbeddingPort(embeddingService),
    auditService,
    ingestionSettingsService,
    chunkingStrategyRegistry,
    documentSourceContentService,
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    documentRepository,
    documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    createLogger("silent"),
    undefined,
    undefined,
    undefined,
    telemetryService,
  );
  const documentIngestionService = new DocumentIngestionService(
    documentRepository,
    auditService,
    () => documentProcessingJobRepository.getQueueSnapshot(),
    undefined,
    undefined,
    productAnalyticsService,
    usageLimitPolicy,
    documentSourceRepository,
  );
  const documentImportService = new DocumentImportService(
    documentRepository,
    auditService,
    documentStorage,
    () => documentProcessingJobRepository.getQueueSnapshot(),
    undefined,
    undefined,
    usageLimitPolicy,
    documentSourceRepository,
  );
  const documentDeletionService = new DocumentDeletionService(
    documentRepository,
    documentStorage,
    auditService,
  );
  const drainDocumentProcessingQueue = async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const processed = await documentProcessingWorker.runOnce();
      if (!processed) {
        break;
      }
    }
  };
  const originalIngest = documentIngestionService.ingest.bind(documentIngestionService);
  documentIngestionService.ingest = async (input) => {
    const result = await originalIngest(input);
    await drainDocumentProcessingQueue();
    return result;
  };
  const originalUpdate = documentIngestionService.update.bind(documentIngestionService);
  documentIngestionService.update = async (input) => {
    const result = await originalUpdate(input);
    await drainDocumentProcessingQueue();
    return result;
  };
  const workbenchReplayRunner = overrides.workbenchReplayRunner ?? {
    async run() {
      return {
        answer: "",
        citations: [],
        answerSegments: [],
        turnTrace: {
          version: 1,
          spine: {
            traceId: "test-workbench-replay",
            startedAt: new Date(0).toISOString(),
            stages: [],
          },
        },
        resolvedConfig: {
          composedInstructions: "",
          modelProvider: "test",
          modelId: "test",
          retrievedChunks: [],
        },
      };
    },
  };
  const originalReprocess = documentIngestionService.reprocess.bind(documentIngestionService);
  documentIngestionService.reprocess = async (input) => {
    const result = await originalReprocess(input);
    await drainDocumentProcessingQueue();
    return result;
  };
  const originalWorkspaceReprocess = workspaceIngestionReprocessService.reprocessWorkspace.bind(workspaceIngestionReprocessService);
  workspaceIngestionReprocessService.reprocessWorkspace = async (workspaceId) => {
    const result = await originalWorkspaceReprocess(workspaceId);
    await drainDocumentProcessingQueue();
    return result;
  };
  const retrievalPipeline = new RetrievalPipelineService(
    createSystemRetrievalDefaultsProvider(),
    queryEmbeddings,
    vectorCandidates,
    lexicalSearch,
    new ConversationContextService(),
    new QueryRewriteService(queryRewriteGateway, triggerAnalysisGateway),
    new CandidatePreparationService(),
    new AttributeMatchScoringService(),
    new RerankService(rerankGateway),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(telemetryService),
    undefined,
    createRetrievalSkillSettingsResolver(),
    chunkHydrator,
  );
  const documentSearchService = new DocumentSearchService(
    documentRepository,
    retrievalPipeline,
    auditService,
  );
  const documentSearchHistoryService = new DocumentSearchHistoryService(
    auditEventRepository,
    documentRepository,
  );
  const defaultChatGateway: ChatGateway = {
    async answer(input): Promise<string> {
      const firstContext = input.prompt
        .match(/Result 1 \([^)]+\): ([\s\S]*?)(?:\n\n|$)/)?.[1]
        ?.trim();

      if (firstContext) {
        return `${firstContext}[[1]]`.trim();
      }

      return `history:${input.history.length} ${input.query}`.trim();
    },
    async *streamAnswer(input) {
      const content = await this.answer(input);
      const midpoint = Math.max(1, Math.ceil(content.length / 2));
      yield content.slice(0, midpoint);
      await delay(5);
      yield content.slice(midpoint);
    },
  };
  const chatGateway = overrides.chatGateway ?? defaultChatGateway;
  const turnRouter = overrides.turnRouter ?? {
    async classify(input) {
      const normalized = input.query.toLowerCase().trim();
      const identity = normalized.includes("who are you") || normalized.includes("your name");
      const direct = identity || ["thanks", "thank you", "ok", "okay", "got it", "hello", "hi"].includes(normalized);
      return {
        route: direct ? "direct" as const : "retrieval" as const,
        framing: {
          isIdentityQuestion: identity,
        },
      };
    },
  } satisfies TurnRouter;
  const workspaceService = new WorkspaceService(workspaceRepository, auditService, accountMembershipRepository);
  const workspaceSummaryService = new WorkspaceSummaryService(documentRepository, conversationRepository, {
    websiteCrawlerEnabled: env.WEBSITE_CRAWLER_ENABLED,
  });
  const workspaceSessionService = new WorkspaceSessionService(workspaceService);
  const abuseControlService = new AbuseControlService(
    overrides.abuseControlRepository ?? new InMemoryAbuseControlRepository(),
  );
  const workspaceProviderCredentialsService = new WorkspaceProviderCredentialsService(
    new InMemoryWorkspaceProviderCredentialsRepository(),
    auditService,
    { key: env.CONNECTOR_ENCRYPTION_KEY },
  );
  const oauthConnectionRepository = new InMemoryOauthConnectionRepository();
  const integrationConnectionRepository = new InMemoryIntegrationConnectionRepository();
  const slackInstallationRepository = new InMemorySlackInstallationRepository();
  const slackBindingRepository = new InMemorySlackBindingRepository();
  const slackInstallationService = new SlackInstallationService({
    oauthConnections: oauthConnectionRepository,
    integrationConnections: integrationConnectionRepository,
    installations: slackInstallationRepository,
    bindings: slackBindingRepository,
    workspaceAccounts: {
      getAccountId: async (workspaceId) => (await workspaceRepository.findById(workspaceId))?.accountId ?? null,
    },
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
  });
  const slackProvider = buildSlackOauthProviderDefinition({
    clientId: "test-slack-client",
    clientSecret: "test-slack-secret",
  });
  const oauthConnectionService = new OauthConnectionService({
    repository: oauthConnectionRepository,
    providers: new StaticOauthProviderRegistry([
      {
        id: "google_mail",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "test-google-client",
        clientSecret: "test-google-secret",
        defaultScopes: [
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        allowedScopes: [
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
      {
        id: "microsoft_graph_mail",
        authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        clientId: "test-microsoft-client",
        clientSecret: "test-microsoft-secret",
        defaultScopes: ["Mail.ReadWrite", "Mail.Send"],
        allowedScopes: ["Mail.ReadWrite", "Mail.Send"],
      },
      {
        id: "test_mail",
        authorizationEndpoint: "https://oauth.test.example.com/authorize",
        tokenEndpoint: "https://oauth.test.example.com/token",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        defaultScopes: ["mail.send"],
        allowedScopes: ["mail.send", "mail.read"],
      },
      ...(slackProvider ? [slackProvider] : []),
    ]),
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
    appBaseUrl: env.APP_BASE_URL,
    apiBaseUrl: env.CONNECTOR_PUBLIC_BASE_URL ?? env.APP_BASE_URL,
    assertPublicUrl: () => undefined,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("slack.com")
        ? {
            ok: true,
            access_token: "xoxb-test-slack-token",
            token_type: "bot",
            scope: slackBotScopes.join(","),
            team: { id: "TTEST", name: "Test Slack" },
            bot_user_id: "UTESTBOT",
            authed_user: { id: "UINSTALLER" },
          }
        : { access_token: "test-access-token", refresh_token: "test-refresh", expires_in: 3600 },
    }),
    logger,
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
  const customerEmailConnectionRepository = new InMemoryCustomerEmailConnectionRepository();
  const emailSkillDefinitionRepository = new InMemoryEmailSkillDefinitionRepository();
  const emailSkillActivityRepository = new InMemoryEmailSkillActivityRepository();
  const webhookSkillDefinitionRepository = new InMemoryWebhookSkillDefinitionRepository();
  const slackSkillDefinitionRepository = new InMemorySlackSkillDefinitionRepository();
  const agentSkillRepository = new InMemoryAgentSkillRepository();
  customerEmailConnectionRepository.setReferenceChecker((connectionId) =>
    emailSkillDefinitionRepository.countByConnection("", connectionId),
  );
  const customerEmailConnectionService = new CustomerEmailConnectionService({
    repository: customerEmailConnectionRepository,
    oauthConnections: oauthConnectionService,
    providers: new StaticCustomerEmailProviderRegistry([
      new MockCustomerEmailProviderAdapter("google_mail"),
      new MockCustomerEmailProviderAdapter("microsoft_graph_mail"),
      new MockCustomerEmailProviderAdapter("test_mail"),
    ]),
  });
  const mcpConnectionRepository = new InMemoryMcpConnectionRepository();
  const externalSkillDefinitionRepository = new InMemoryExternalSkillDefinitionRepository();
  // Model the ON DELETE RESTRICT FK so the route DELETE 409 is exercised.
  mcpConnectionRepository.setReferenceChecker((connectionId) =>
    externalSkillDefinitionRepository.hasConnectionReference(connectionId),
  );
  const mcpConnectionService = new McpConnectionService({
    repository: mcpConnectionRepository,
    toolServiceFactory: createMockToolServiceFactory(),
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
    // No-op in tests (avoids real DNS); SSRF enforcement is unit-tested directly.
    assertPublicUrl: () => undefined,
    // Deterministic OAuth wiring for route tests (no real authorization server).
    oauthRedirectUri: "https://app.test.example.com/oauth/mcp-callback",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "test-access-token", refresh_token: "test-refresh", expires_in: 3600 }),
    }),
  });
  const externalSkillDefinitionService = new ExternalSkillDefinitionService(
    externalSkillDefinitionRepository,
    mcpConnectionService,
  );
  const emailSkillDefinitionService = new EmailSkillDefinitionService({
    repository: emailSkillDefinitionRepository,
    connections: customerEmailConnectionRepository,
  });
  const workspaceLlmCapabilitySettingsService = new WorkspaceLlmCapabilitySettingsService(
    retrievalSettingsRepository,
    auditService,
  );
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.setEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY!);
  const connectorDb = new InMemoryConnectorDatabase();
  const agentRepository = new InMemoryAgentRepository(createDefaultAgentSkillSettingsRegistry());
  const contextVariableRepository = new InMemoryContextVariableRepository();
  const identityNonces = new Map<string, Date>();
  const identityNonceRepository = {
    async isUsed(nonce: string) {
      const expiresAt = identityNonces.get(nonce);
      return Boolean(expiresAt && expiresAt.getTime() > Date.now());
    },
    async markUsed(nonce: string, _workspaceId: string, expiresAt: Date) {
      if (identityNonces.has(nonce)) {
        throw new Error("Identity nonce has already been used");
      }
      identityNonces.set(nonce, expiresAt);
    },
    async deleteExpired(now: Date) {
      let deleted = 0;
      for (const [nonce, expiresAt] of identityNonces) {
        if (expiresAt.getTime() <= now.getTime()) {
          identityNonces.delete(nonce);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
  const routineDefinitionRepository = new InMemoryRoutineDefinitionRepository();
  const webhookDestinationRepository = new InMemoryWebhookDestinationRepository();
  const webhookDestinations = new DefaultWebhookDestinationAdapter(new WebhookDestinationService({
    repository: webhookDestinationRepository,
    auditService,
    encryption: { key: env.CONNECTOR_ENCRYPTION_KEY },
    assertPublicUrl: async () => undefined,
    routineReferences: routineDefinitionRepository,
    skillReferences: {
      async listAgentSkillNamesReferencingDestination(workspaceId, destinationId) {
        return webhookSkillDefinitionRepository.listSkillNamesByDestination(workspaceId, destinationId);
      },
    },
  }));
  const webhookSkillDefinitionService = new WebhookSkillDefinitionService({
    repository: webhookSkillDefinitionRepository,
    destinations: webhookDestinations,
  });
  const slackSkillDefinitionService = new SlackSkillDefinitionService({
    repository: slackSkillDefinitionRepository,
    installations: slackInstallationRepository,
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
        documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
        documentSourceRepository.countDocumentsWithoutSource(workspaceId),
      ]);
      return [
        ...sources.map((source) => ({
          id: source.id,
          label: source.name,
          status: source.lastSyncStatus ?? undefined,
        })),
        ...(manualDocumentCount > 0
          ? [{
              id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID,
              label: "Manually added documents",
              status: "available",
            }]
          : []),
      ];
    },
  });
  const agentSkillsService = new AgentSkillsService({
    repository: agentSkillRepository,
    capabilities: skillCapabilityRegistry,
    logger,
  });
  const accessGrantService = new AccessGrantService({
    repository: accessGrantRepository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: env.WORKSPACE_TOKEN_SECRET,
    auditService,
  });
  const agentService = new AgentService(
    agentRepository,
    workspaceRepository,
    documentSourceRepository,
    undefined,
    accessGrantService,
  );
  const authoredDirectiveService = new AuthoredDirectiveService({
    repository: agentRepository,
    coherenceChecker: {
      async check() {
        return {
          coherent: true,
          conflicts: [],
          rationale: "The candidate can be followed with the existing directives.",
        };
      },
    },
    registeredCapabilityNames,
    agentSkills: agentSkillRepository,
  });
  const skillCatalogRegistry = createDefaultSkillCatalogRegistry();
  const skillExecutorRegistry = overrides.skillExecutorRegistry ?? new SkillExecutorRegistry();
  const capabilityPolicy = new DefaultAllowCapabilityPolicy();
  const skillCatalogService = new SkillCatalogService({
    capabilityPolicy,
    registry: skillCatalogRegistry,
  });
  const skillAuthoringCatalog = new SkillAuthoringCatalogService({
    skillCatalog: skillCatalogService,
    externalSkills: externalSkillDefinitionService,
  });
  const routineDefinitionService = new RoutineDefinitionService({
    agentRepository,
    repository: routineDefinitionRepository,
    skillAuthoringCatalog,
    contextVariableReader: contextVariableRepository,
    webhookDestinations: {
      existsByIdAndWorkspace: async (inputWorkspaceId, destinationId) =>
        webhookDestinations.existsByIdAndWorkspace(inputWorkspaceId, destinationId),
    },
    auditService,
    directiveScopeTags: agentRepository,
  });
  const chatInferencePipeline: AppDependencies["chatInferencePipeline"] = {
    metadata: { capability: "chat" as const, provider: "openai" as const, model: "test" },
    complete: overrides.chatInferencePipelineComplete ?? (async () => textResult("")),
    stream() { return streamResult([""]); },
  };
  const directiveAuthorService = new DirectiveAuthorService({
    repository: agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...input }) =>
        (await chatInferencePipeline.complete(input)).text,
    },
    logger,
    telemetryService,
    buildStepScopeTag: scopeTag.step,
  });
  const routineDraftAssistService = new RoutineDraftAssistService({
    repository: agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...input }) =>
        (await chatInferencePipeline.complete(input)).text,
    },
    actionCatalog: [{ type: "contact.send", kind: "action" }],
    logger,
    telemetryService,
  });
  const agentSurfaceExtensions = new AgentSurfaceExtensionRegistry();
  // Mimic an EE deployment for OSS contract/unit tests so the runtime gate on
  // embed-only routes (settingsRoutes, agentRoutes, publicChatRoutes) doesn't
  // 404 them. A pass-through normalize keeps existing fixtures intact.
  agentSurfaceExtensions.register({
    key: "websiteEmbed",
    defaults: () => ({}),
    normalize: (value: unknown) => value,
    serialize: (value: unknown) => value,
    parse: (value: unknown) => value,
  });

  const chatHistoryService = new ChatHistoryService(
    conversationRepository,
    messageRepository,
    auditEventRepository,
    new InMemoryHistoryItemsRepository(conversationRepository, auditEventRepository),
    overrides.contactHistoryProvider ?? new NoopContactHistoryProvider(),
    overrides.answerFeedbackHistoryProvider,
    conversationOwnershipRepository,
  );
  const routineStateStore = new InMemoryRoutineStateStore();
  const directiveStateStore = new InMemoryDirectiveStateStore();
  const conversationForkService = new ConversationForkService(
    conversationRepository,
    messageRepository,
    routineStateStore,
  );
  const publicChatActionAdvertisers = [
    ...(overrides.publicChatActionAdvertiser ? [overrides.publicChatActionAdvertiser] : []),
  ];
  const publicChatActionAdvertiser = publicChatActionAdvertisers.length === 0
    ? new NoopPublicChatActionAdvertiser()
    : publicChatActionAdvertisers.length === 1
      ? publicChatActionAdvertisers[0]!
      : new ChainedPublicChatActionAdvertiser(publicChatActionAdvertisers);
  const fallbackReplyComposer = overrides.fallbackReplyComposer ?? new TestFallbackReplyComposer();
  const publishedRoutineSource = createPublishedRoutineRegistrationSource(routineDefinitionRepository, {
    onDefinitionError: ({ agentId, definitionId, error }) => {
      logger.warn(
        {
          agentId,
          definitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Published routine definition failed to compile; skipping",
      );
    },
    onPinnedDefinitionError: ({ agentId, routineId, definitionId, error }) => {
      logger.warn(
        {
          agentId,
          routineId,
          definitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Pinned routine definition failed to load or compile; skipping resume-only registration",
      );
    },
  });
  const staticRoutineRegistrations: RoutineRegistration[] = [];
  const routineProvider: ChatRoutineProvider = {
    async forTurn({ modelGateway, agentId, pinnedRoutineIds = [], responseLanguage, groundedAnswerRenderer }) {
      let publishedRegistrations: RoutineRegistration[];
      try {
        publishedRegistrations = await publishedRoutineSource.load({ agentId });
      } catch (error) {
        logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Published routine definitions failed to load; continuing without DB-backed routines",
        );
        publishedRegistrations = [];
      }
      let pinnedRegistrations: RoutineRegistration[];
      try {
        pinnedRegistrations = await publishedRoutineSource.loadPinned({ agentId, routineIds: pinnedRoutineIds });
      } catch (error) {
        logger.warn(
          {
            agentId,
            routineIds: pinnedRoutineIds,
            err: error instanceof Error ? error.message : String(error),
          },
          "Pinned routine definitions failed to load; continuing without resume-only DB-backed routines",
        );
        pinnedRegistrations = [];
      }
      const routineRegistry = new RoutineRegistry([
        ...staticRoutineRegistrations,
        ...publishedRegistrations,
      ]);
      const routinesById = new Map(routineRegistry.routines.map((routine) => [routine.id, routine]));
      for (const registration of pinnedRegistrations) {
        routinesById.set(registration.routine.id, registration.routine);
      }
      const routines = [...routinesById.values()];
      if (routineRegistry.isEmpty && routines.length === 0) {
        return null;
      }
      return {
        activator: routineRegistry.isEmpty
          ? { activate: async () => null }
          : routineRegistry.activator(modelGateway),
        runner: new DefaultRoutineRunner(
          routines,
          new RoutineNextStepSelector(modelGateway, {
            promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
          }),
          new RoutineStepRenderer(modelGateway, {
            promptTemplate: loadPromptTemplate("chat/routine-step-reply.md"),
            responseLanguage,
            groundedAnswerRenderer,
          }),
        ),
      };
    },
  };
  const chatService = new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn: new RetrievalTurnController(retrievalPipeline),
    chatGateway,
    auditService,
    turnRuntime: buildChatTurnRuntime({
      chatGateway,
      fallbackReplyComposer,
      skillOutcomeCapabilities: createSkillOutcomeCapabilityProvider(skillCatalogRegistry),
    }),
    productAnalyticsService,
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    usageLimitPolicy,
    agentService,
    contextVariableRepository,
    turnRouter,
    conversationEngine: createConversationEngine(),
    routineStore: routineStateStore,
    routineProvider,
    // Mirror production wiring (dependencyBuilders): a real route-scoped directive
    // runtime so authored directives are matchable in integration tests. Built-in
    // registrations stay empty to keep existing test prompts unchanged; the default
    // deterministic matcher covers `always` directives without an LLM gateway.
    directiveSteering: createRouteScopedDirectiveSteering({
      capabilityPolicy,
      registrations: [],
    }),
    // Per-conversation directive firing memory (#865) so lifecycle suppression is
    // exercised end-to-end; exposed on the returned harness for assertions.
    directiveStateStore,
    agentSkillTurnSkillProvider: overrides.agentSkillTurnSkillProvider ?? new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: agentSkillRepository,
      executorRegistry: skillExecutorRegistry,
      capabilityPolicy,
    }),
    conversationTurnRegistry: new InMemoryConversationTurnRegistry(
      new LoggingConversationTurnInterruptionObserver(logger, metricsRegistry),
    ),
    logger,
  });
  const chatBootstrapService = new ChatBootstrapService(
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    chatGateway,
    auditService,
    usageLimitPolicy,
    productAnalyticsService,
    agentService,
  );
  const assistantChatService = new AssistantChatService(chatService, chatBootstrapService);
  const agentTurnProbeService = new AgentTurnProbeService({
    conversationReader: conversationRepository,
    agentReader: {
      findByIdAndWorkspaceId: (agentId, workspaceId) => agentService.resolve(workspaceId, agentId),
    },
    routineReader: routineDefinitionRepository,
    abuseControl: abuseControlService,
    audit: auditService,
    abusePolicy: {
      limit: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    },
    turnRunner: {
      run: async (input) => {
        const receipt = await chatService.answerWithReceipt({
          ...input,
          stream: false,
          executionMode: "safe_test",
        });
        return {
          conversationId: receipt.response.conversationId,
          userMessageId: receipt.userMessageId,
          assistantMessageId: receipt.response.assistantMessageId,
          agentId: receipt.response.agentId ?? input.agentId,
          answer: receipt.response.answer,
          citations: receipt.response.citations ?? [],
          skillOutcome: receipt.response.skillOutcome,
          answerOutcome: receipt.response.answerOutcome,
          activitySummary: receipt.response.activitySummary,
          activityTrace: receipt.response.activityTrace,
          turnTrace: receipt.response.turnTrace,
        };
      },
    },
  });
  // The action outbox drain never runs in tests; a no-op dispatcher satisfies the shape.
  const actionDispatchWorker = new ActionDispatchWorker(
    { dispatchPending: async () => ({ dispatched: 0, retried: 0, failed: 0 }) },
    { logger },
  );
  const assistantHistoryService = new AssistantHistoryService(chatHistoryService);
  const publicConversationEventBus = new InMemoryPublicConversationEventBus();
  const operatorReplyService = new OperatorReplyService({
    conversationRepository,
    messageRepository,
    auditService,
    publicConversationEventBus,
    customerReplyDelivery: { deliver: async () => {} },
  });
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline);
  const retrievalAnswerService = new RetrievalAnswerService({
    retrievalPipeline,
    chatGateway,
    usageLimitPolicy,
    auditService,
  });
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository,
    auditService,
    agentService,
    accessGrantService,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
  });
  const retrievalDefaultsProvider = createSystemRetrievalDefaultsProvider();
  const approvalDecisionService = new ApprovalDecisionService(
    {
      listPending: async () => [],
      loadByHandle: async () => null,
      resolveInTransaction: async () => null,
    },
    {
      resume: async () => {
        throw new Error("approval_resume_not_configured");
      },
    },
    {
      resolveWorkspaceRole: (caller) => accountAccessService.resolveWorkspaceRole(caller),
    },
  );
  const evalRepository = createInMemoryEvalRepository();
  const evalSnapshotService = new EvalSnapshotService(
    conversationRepository,
    messageRepository,
    agentRepository,
    retrievalDefaultsProvider,
    createRetrievalSkillSettingsResolver(),
    evalRepository,
  );
  const evalMessageCaseService = new EvalMessageCaseService(
    evalRepository,
    evalSnapshotService,
    logger,
  );
  const evalRunService = new EvalRunService(
    evalRepository,
    {
      async retrieve(_input: { history: unknown[] }) { return { chunks: [] }; },
      async answer(_input: { history: unknown[]; runId: string }) {
        return { chunks: [], answer: "" };
      },
    } as any,
    {
      async judge({ assertion }) {
        return { assertion, status: "error" as const, reason: "Judge is not configured in test app." };
      },
    },
    workbenchReplayRunner as any,
    logger,
  );
  const evalCaseService = new EvalCaseService(evalRepository);
  const qualitySignalsService = {
    getQualityStats: async () => ({ backlog: {} }),
    listLowQualityTurns: async () => ({ items: [] }),
  };
  const audiencePulseService = {
    read: async () => ({ kind: "not_generated" }),
    refresh: async () => ({ kind: "not_generated" }),
    readEvidenceAnchor: async () => null,
  } as unknown as AppDependencies["audiencePulseService"];
  const copilotRepository = new InMemoryCopilotRepository();
  const copilotProposalAdapters = [
    createDirectiveCopilotProposalAdapter({ authoredDirectiveService, directiveAuthorService, agentService }),
    createAgentSettingCopilotProposalAdapter({ agentService }),
    createRoutineCopilotProposalAdapter({ agentService, routineDraftAssistService, routineDefinitionService }),
  ] as const;
  const operatorCopilotService = new OperatorCopilotService({
    repository: copilotRepository,
    capabilityRunner: new AgenticCapabilityRunner({
      runtime: new DefaultAgentRuntime({ gateway: new TextRoutedToolCallingGateway(chatInferencePipeline) }),
    }),
    usageLimitPolicy,
    auditService,
    proposalAdapters: copilotProposalAdapters,
    prompt: loadPromptTemplate("copilot/system.md"),
    tools: createCopilotToolCatalog({
      agentService: {
        get: agentService.get.bind(agentService),
        listExisting: agentService.listExisting.bind(agentService),
        resolve: agentService.resolve.bind(agentService),
      },
      routineDefinitionService: {
        get: routineDefinitionService.get.bind(routineDefinitionService),
        list: routineDefinitionService.list.bind(routineDefinitionService),
      },
      chatHistoryService,
      agentTurnProbe: agentTurnProbeService,
      documentSearchService,
      evalResultsService: evalCaseService,
      qualitySignalsService,
      audiencePulseService,
      documentStatusService: documentIngestionService,
      documentSourceStatusService: documentSourceRepository,
      agentSkillsService,
      skillCapabilityRegistry,
      workspaceSettings: {
        async getRetrievalDefaults(workspaceId) {
          return retrievalDefaultsProvider.getDefaults(workspaceId);
        },
        async getIngestionSettings(workspaceId) {
          return ingestionSettingsService.getForWorkspace(workspaceId);
        },
        async getEmbeddingCoverage(workspaceId) {
          return documentProcessingJobRepository
            .getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
        },
        async listLlmModels(workspaceId) {
          return workspaceLlmCapabilitySettingsService.listForWorkspace(workspaceId);
        },
        async getProviderCredentialHealth(workspaceId) {
          return {
            encryptionConfigured: workspaceProviderCredentialsService.isEncryptionConfigured(),
            credentials: await workspaceProviderCredentialsService.listConfigured(workspaceId),
            envProviderAvailability: {
              openai: Boolean(env.OPENAI_API_KEY),
              "openai-compatible": Boolean(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY),
              gemini: Boolean(env.GEMINI_API_KEY),
              claude: Boolean(env.ANTHROPIC_API_KEY),
            },
          };
        },
        async getGeneralSettings(workspaceId) {
          return platformSettingsService.getForWorkspace(workspaceId);
        },
      },
      proposalRepository: copilotRepository,
      proposalAdapters: copilotProposalAdapters,
      auditService,
      workspaceRepository,
    }),
  });
  const dependencies: AppDependencies = {
    env,
    logger,
    operatorCopilotService,
    qualitySignalsService: qualitySignalsService as any,
    audiencePulseService,
    copilotRepository,
    metricsRegistry,
    telemetryService,
    errorReportingService: persistentErrorReportingService,
    productAnalyticsService,
    capabilityPolicy,
    usageLimitPolicy,
    usageEventRecorder,
    organizationCreationGuard,
    publicChatActionAdvertiser,
    publicConversationEventBus,
    contactHistoryProvider: overrides.contactHistoryProvider ?? new NoopContactHistoryProvider(),
    applicationRouteMounts: overrides.applicationRouteMounts ?? [],
    applicationModules: new ApplicationModuleCoordinator({
      logger,
      registry: createApplicationExtensionRegistry(),
    }),
    auditService,
    mailService: createMailService({ MAIL_DRIVER: "noop" }),
    accountAccessService,
    accountInvitationService,
    workspaceSessionService,
    abuseControlService,
    workspaceProviderCredentialsService,
    oauthConnectionService,
    slackInstallationService,
    customerEmailOAuthService,
    customerEmailConnectionService,
    emailSkillDefinitionService,
    webhookSkillDefinitionService,
    slackSkillDefinitionService,
    skillCapabilityRegistry,
    agentSkillsService,
    emailSkillActivityRepository,
    mcpConnectionService,
    externalSkillDefinitionService,
    webhookDestinations,
    workspaceLlmCapabilitySettingsService,
    llmCapabilityResolver: {
      async resolve() {
        throw new Error("Workspace LLM capability resolution is not configured in the in-memory test app");
      },
    },
    authService: new AuthService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository,
      workspaceTokenRepository,
      workspaceService,
      accountAccessService,
      accountInvitationService,
      organizationCreationGuard,
      organizationProvisioner: new InMemoryOrganizationProvisioner(
        accountRepository,
        userRepository,
        accountAccessService,
        workspaceService,
      ),
    }),
    accessGrantService,
    passwordResetService: new PasswordResetService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository,
      accountAccessService,
      workspaceService,
      passwordResetTokenRepository: new InMemoryPasswordResetTokenRepository(),
      mailService: createMailService({ MAIL_DRIVER: "noop" }),
    }),
    emailVerificationService: new EmailVerificationService({
      env,
      auditService,
      userRepository,
      emailVerificationTokenRepository: new InMemoryEmailVerificationTokenRepository(),
      mailService: createMailService({ MAIL_DRIVER: "noop" }),
    }),
    workspaceService,
    workspaceSummaryService,
    ingestionSettingsService,
    embeddingCoverageReport: documentProcessingJobRepository,
    chunkRepository,
    documentRepository,
    documentIngestionService,
    documentSourceRepository,
    documentImportService,
    documentSearchService,
    documentSearchHistoryService,
    workspaceIngestionReprocessService,
    embeddingBindingResolver: {
      async resolveBinding() {
        throw new Error("Embedding binding resolution is not configured in the in-memory test app");
      },
      async resolveBindingForSpace() {
        throw new Error("Embedding binding resolution is not configured in the in-memory test app");
      },
    },
    documentSourceReprocessService,
    documentProcessingWorker,
    websiteCrawlJobService: {
      enqueue: async () => ({
        jobId: "11111111-1111-4111-8111-111111111111",
        sourceId: null,
        requestedUrl: "https://example.com",
        status: "queued" as const,
      }),
      cancelJobsForSource: async () => 0,
    } as any,
    websiteCrawlWorker: {
      start: async () => undefined,
      stop: async () => undefined,
      runJobById: async () => "noop" as const,
      runOnce: async () => false,
    } as any,
    documentDeletionService,
    documentStorage,
    chatService,
    approvalDecisionService,
    operatorReplyService,
    workbenchReplayRunner: workbenchReplayRunner as any,
    actionDispatchWorker,
    chatBootstrapService,
    chatHistoryService,
    conversationForkService,
    assistantChatService,
    assistantHistoryService,
    retrievalSearchService,
    retrievalAnswerService,
    retrievalDefaultsProvider,
    evalSnapshotService,
    evalMessageCaseService,
    evalCaseService,
    evalRunService,
    evalSuiteService: new EvalSuiteService(evalRepository, evalRunService, logger),
    platformSettingsService,
    agentService,
    authoredDirectiveService,
    routineDefinitionService,
    routineDraftAssistService,
    directiveAuthorService,
    agentSurfaceExtensions,
    skillCatalogService,
    skillAuthoringCatalog,
    accountRepository,
    userRepository,
    workspaceRepository,
    agentRepository,
    contextVariableRepository,
    identityNonceRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    conversationOwnershipRepository,
    messageRepository,
    connectorRegistry,
    connectorManagementService: new ConnectorManagementService({
      database: connectorDb as any,
      registry: connectorRegistry,
    }),
    connectorIngestionPort: {
      async ingest() { return { documentId: "test-doc", status: "queued" }; },
      async deleteByExternalId() { return false; },
      async ensureSource() { return { id: "test-source" }; },
    },
    connectorDb: connectorDb as any,
    chatInferencePipeline,
    crawlerProvider: {
      async fetchPageWithScreenshot() { return { url: "", title: null, text: "", links: [], screenshot: null, faviconUrl: null }; },
      async crawlSite() { return []; },
      async isBrowserTransportAvailable() { return false; },
    },
    assertPublicWebsiteUrl: async () => {},
    websiteCrawlerLimits: { defaultLimit: 100, maxLimit: 1000 },
  };

  void connectorRegistry.initializeAll({
    db: connectorDb as any,
    logger: dependencies.logger,
    chat: createConnectorChatPort(dependencies.chatService),
    ingestion: dependencies.connectorIngestionPort,
  });

  return {
    dependencies,
    routineStateStore,
    directiveStateStore,
    repositories: {
      auditEventRepository,
      accessGrantRepository,
      userRepository,
      ingestionSettingsRepository,
      retrievalSettingsRepository,
      documentRepository,
      documentSourceRepository,
      chunkRepository,
      documentProcessingJobRepository,
      conversationRepository,
      conversationOwnershipRepository,
      messageRepository,
      agentRepository,
      agentSkillRepository,
      routineDefinitionRepository,
    },
  };
};

export const createTestApp = (overrides: {
  chatGateway?: ChatGateway;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  turnRouter?: TurnRouter;
  triggerAnalysisGateway?: TriggerAnalysisGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  fallbackReplyComposer?: FallbackReplyComposer;
  usageLimitPolicy?: UsageLimitPolicy;
  organizationCreationGuard?: OrganizationCreationGuard;
  answerFeedbackHistoryProvider?: AnswerFeedbackHistoryProviderPort;
  contactHistoryProvider?: ContactHistoryProviderPort;
  publicChatActionAdvertiser?: PublicChatActionAdvertiserPort;
  applicationRouteMounts?: ApplicationRouteMount[];
  workbenchReplayRunner?: Pick<WorkbenchReplayRunner, "run">;
  chatInferencePipelineComplete?: AppDependencies["chatInferencePipeline"]["complete"];
  logger?: AppDependencies["logger"];
  skillExecutorRegistry?: SkillExecutorRegistry;
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
} = {}) => {
  const { dependencies, repositories, routineStateStore, directiveStateStore } = createTestDependencies(overrides);
  const app = createApp(dependencies);
  appDependencyMap.set(app, dependencies);
  appRepositoryMap.set(app, repositories);
  return {
    app,
    dependencies,
    repositories,
    routineStateStore,
    directiveStateStore,
  };
};

/**
 * Registers, verifies, and signs in a test user before issuing a workspace token.
 * Returns both the bearer token and the session cookie.
 */
export const issueTestToken = async (
  app: ReturnType<typeof createTestApp>["app"],
  email = `test-${randomUUID()}@example.com`,
): Promise<{ token: string; cookie: string; workspaceId: string; accountId: string }> => {
  const { cookie, workspaceId, accountId } = await issueTestSession(app, email);

  const workspaces = await request(app)
    .get("/api/v1/workspace")
    .set("Cookie", cookie);
  const resolvedWorkspaceId: string = workspaces.body.workspaces[0].id ?? workspaceId;
  const dependencies = appDependencyMap.get(app);
  if (!dependencies) {
    throw new Error("Test app dependencies were not registered for token issuance");
  }

  const tokenResponse = await dependencies.authService.getTokenForWorkspace(resolvedWorkspaceId, accountId);

  return { token: tokenResponse.token, cookie, workspaceId: resolvedWorkspaceId, accountId };
};

export const issueTestSession = async (
  app: ReturnType<typeof createTestApp>["app"],
  email = `test-${randomUUID()}@example.com`,
): Promise<{ cookie: string; workspaceId: string; userId: string; accountId: string }> => {
  const password = "verysecurepassword";
  const dependencies = appDependencyMap.get(app);
  if (!dependencies) {
    throw new Error("Test app dependencies were not registered for session issuance");
  }
  const repositories = appRepositoryMap.get(app);
  if (!repositories) {
    throw new Error("Test app repositories were not registered for session issuance");
  }

  const register = await dependencies.authService.register({
    email,
    password,
  });
  await repositories.userRepository.markEmailVerified(register.userId, new Date());

  const login = await dependencies.authService.login({
    email,
    password,
  });

  return {
    cookie: login.sessionCookie,
    workspaceId: login.workspaceId,
    userId: login.userId,
    accountId: login.accountId,
  };
};

export const adminSessionHeaders = (session: { cookie: string; workspaceId: string }) => ({
  Cookie: session.cookie,
  "X-Workspace-Id": session.workspaceId,
});

const keywordScore = (content: string, query: string): number => {
  const lowerContent = content.toLowerCase();
  const normalizedTerms = normalizeTerms(query);

  if (normalizedTerms.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const term of normalizedTerms) {
    if (lowerContent.includes(term)) {
      matches += 1;
    }
  }

  return matches / normalizedTerms.length;
};

const keywordAllTermsMatch = (content: string, query: string): boolean => {
  const lowerContent = content.toLowerCase();
  const normalizedTerms = normalizeTerms(query);

  return normalizedTerms.length > 0 && normalizedTerms.every((term) => lowerContent.includes(term));
};

const keywordEmbedding = (text: string): number[] => {
  const vector = new Array<number>(8).fill(0);
  const terms = normalizeTerms(text);

  for (const term of terms) {
    const bucket = hashTerm(term) % vector.length;
    vector[bucket] += 1;
  }

  return vector;
};

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const normalizeTerms = (text: string): string[] =>
  [...wordSegmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((term) => term.length > 2);

const normalizeRewriteContext = (text: string): string =>
  text
    .trim()
    .replace(/[?.!]+$/g, "")
    .trim();

const hashTerm = (term: string): number => {
  let hash = 0;

  for (let index = 0; index < term.length; index += 1) {
    hash = (hash * 31 + term.charCodeAt(index)) >>> 0;
  }

  return hash;
};

class InMemoryCopilotRepository implements CopilotRepositoryPort {
  private conversations: CopilotConversation[] = [];
  private messages: CopilotMessage[] = [];
  private proposals: CopilotProposal[] = [];

  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> {
    const timestamp = new Date();
    const conversation: CopilotConversation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      operatorUserId: input.operatorUserId,
      title: input.title,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.push(conversation);
    return conversation;
  }

  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> {
    return (
      this.conversations.find(
        (conversation) =>
          conversation.id === input.id &&
          conversation.workspaceId === input.workspaceId &&
          conversation.operatorUserId === input.operatorUserId,
      ) ?? null
    );
  }

  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> {
    return this.conversations
      .filter((conversation) => conversation.workspaceId === input.workspaceId && conversation.operatorUserId === input.operatorUserId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> {
    const existing = await this.findConversation(input);
    if (!existing) return false;
    this.conversations = this.conversations.filter((conversation) => conversation.id !== existing.id);
    this.messages = this.messages.filter((message) => message.conversationId !== existing.id);
    return true;
  }

  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> {
    const message: CopilotMessage = { ...input, id: randomUUID(), createdAt: new Date() };
    this.messages.push(message);
    return message;
  }

  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> {
    return this.messages.filter((message) => message.conversationId === input.conversationId).map((message) => ({
      ...message,
      proposals: this.proposals.filter((proposal) => proposal.messageId === message.id).map((proposal) => ({
        id: proposal.id,
        targetType: proposal.targetType,
        targetLabel: (proposal.targetType === "directive" || proposal.targetType === "routine") && proposal.payload && typeof proposal.payload === "object" && "name" in proposal.payload && typeof proposal.payload.name === "string" ? proposal.payload.name : proposal.targetType === "agent_setting" && proposal.targetRef && typeof proposal.targetRef === "object" && "settingKey" in proposal.targetRef && typeof proposal.targetRef.settingKey === "string" ? proposal.targetRef.settingKey : "",
        summary: proposal.payload && typeof proposal.payload === "object" && "rationale" in proposal.payload && typeof proposal.payload.rationale === "string" ? proposal.payload.rationale : (proposal.targetType === "directive" || proposal.targetType === "routine") && proposal.payload && typeof proposal.payload === "object" && "name" in proposal.payload && typeof proposal.payload.name === "string" ? proposal.payload.name : "",
        status: proposal.status,
        reason: proposal.reason ?? null,
      })),
    }));
  }

  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> {
    const conversation = await this.findConversation(input);
    if (!conversation) return null;
    if (conversation.status === "running") return "running";
    return this.replaceStatus(conversation, "running");
  }

  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> {
    const conversation = await this.findConversation(input);
    if (conversation) this.replaceStatus(conversation, "idle");
  }

  async createProposal(input: Omit<CopilotProposal, "id" | "messageId" | "status" | "appliedRef" | "createdAt" | "updatedAt">): Promise<CopilotProposal> {
    const createdAt = new Date();
    const proposal: CopilotProposal = { ...input, id: randomUUID(), messageId: null, status: "pending", reason: null, appliedRef: null, createdAt, updatedAt: createdAt };
    this.proposals.push(proposal);
    return proposal;
  }

  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> {
    return this.proposals.find((proposal) => proposal.id === input.id && proposal.workspaceId === input.workspaceId && proposal.operatorUserId === input.operatorUserId) ?? null;
  }

  async attachProposalsToMessage(input: { proposalIds: ReadonlyArray<string>; messageId: string; conversationId: string }): Promise<void> {
    this.proposals = this.proposals.map((proposal) => input.proposalIds.includes(proposal.id) && proposal.conversationId === input.conversationId ? { ...proposal, messageId: input.messageId, updatedAt: new Date() } : proposal);
  }

  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown | null; reason?: string | null }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    const updated = { ...proposal, status: input.status, reason: input.reason ?? null, appliedRef: input.appliedRef ?? null, updatedAt: new Date() };
    this.proposals[this.proposals.indexOf(proposal)] = updated;
    return updated;
  }

  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    return proposal?.status === "pending" ? proposal : null;
  }

  private replaceStatus(conversation: CopilotConversation, status: CopilotConversation["status"]): CopilotConversation {
    const next: CopilotConversation = { ...conversation, status, updatedAt: new Date() };
    this.conversations[this.conversations.indexOf(conversation)] = next;
    return next;
  }
}
