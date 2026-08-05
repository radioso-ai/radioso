import { AccountInvitationRepository } from "../../../db/repositories/accountInvitationRepository.js";
import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../../db/repositories/accountRepository.js";
import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { AccessGrantRepository } from "../../../db/repositories/accessGrantRepository.js";
import { AgentRepository } from "../../../db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../../db/repositories/contextVariableRepository.js";
import { IdentityNonceRepository } from "../../../db/repositories/identityNonceRepository.js";
import { RoutineDefinitionRepository } from "../../../db/repositories/routineDefinitionRepository.js";
import { RoutineStateRepository } from "../../../db/repositories/routineStateRepository.js";
import { DirectiveStateRepository } from "../../../db/repositories/directiveStateRepository.js";
import { ConversationSummaryRepository } from "../../../db/repositories/conversationSummaryRepository.js";
import {
  ConversationSummaryService,
  ModelConversationSummaryGenerator,
} from "../../../modules/chat/composition.js";
import { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import { ClarificationStateRepository } from "../../../db/repositories/clarificationStateRepository.js";
import { createConversationEngine } from "@radioso/conversation-engine";
import type { AgentSkillSettingsRegistry, AgentSurfaceExtensionRegistry } from "../../../modules/agents/public.js";
import { AuditEventRepository } from "../../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { DocumentProcessingJobRepository } from "../../../db/repositories/documentProcessingJobRepository.js";
import { EmbeddingProfileJobRepository } from "../../../db/repositories/embeddingProfileJobRepository.js";
import { EmbeddingProfileCleanupRepository } from "../../../db/repositories/embeddingProfileCleanupRepository.js";
import { DocumentRepository } from "../../../db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../../db/repositories/documentSourceRepository.js";
import { EmbeddingProfileRepository } from "../../../db/repositories/embeddingProfileRepository.js";
import { VectorIndexWorkRepository } from "../../../db/repositories/vectorIndexWorkRepository.js";
import { EmailVerificationTokenRepository } from "../../../db/repositories/emailVerificationTokenRepository.js";
import { HistoryItemsRepository } from "../../../db/repositories/historyItemsRepository.js";
import { IngestionSettingsRepository } from "../../../db/repositories/ingestionSettingsRepository.js";
import { MessageRepository } from "../../../db/repositories/messageRepository.js";
import { PasswordResetTokenRepository } from "../../../db/repositories/passwordResetTokenRepository.js";
import { RetrievalSettingsRepository } from "../../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../../db/repositories/sessionRepository.js";
import { UserRepository } from "../../../db/repositories/userRepository.js";
import { WebsiteCrawlJobRepository } from "../../../db/repositories/websiteCrawlJobRepository.js";
import { WorkspaceGrantRepository } from "../../../db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { WorkspaceTokenRepository } from "../../../db/repositories/workspaceTokenRepository.js";
import { LlmResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import { LlmHandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import { PostgresAssistantTurnPersistence } from "../../../modules/chat/infra/postgresAssistantTurnPersistence.js";
import { registeredCapabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import { AccountAccessService, AccountInvitationService } from "../../../modules/account/public.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../../modules/accessGrants/public.js";
import { AgentService } from "../../../modules/agents/public.js";
import { AuditService } from "../../../modules/audit/composition.js";
import { ApprovalDecisionService } from "../../../modules/approvals/public.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import { AuthService } from "../../../modules/auth/services/authService.js";
import { PostgresOrganizationProvisioner } from "../../../modules/auth/infra/postgresOrganizationProvisioner.js";
import { EmailVerificationService } from "../../../modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../../modules/auth/services/passwordResetService.js";
import { WorkspaceSessionService } from "../../../modules/auth/services/workspaceSessionService.js";
import {
  ActionDispatcher,
  ActionDispatchWorker,
  ActionHandlerRegistry,
  AssistantChatService,
  AssistantHistoryService,
  AnswerPresentationService,
  ChatActionSuggestionRegistry,
  ChatActionSuggestionService,
  ChatBootstrapService,
  ChatHistoryService,
  ConversationForkService,
  ChatService,
  ChatTurnAssemblyFactory,
  InMemoryConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  type ChatRoutineProvider,
  type PublicConversationEventBus,
  ChainedPublicChatActionAdvertiser,
  buildChatTurnRuntime,
  createRouteScopedDirectiveSteering,
  createSkillOutcomeCapabilityProvider,
  LlmTurnRouter,
  LlmConversationTurnInterpreter,
  ModelTurnInterpretationGateway,
  ModelTurnRouterGateway,
  NoopAnswerFeedbackHistoryProvider,
  NoopPublicChatActionAdvertiser,
  NoopContactHistoryProvider,
  RetrievalTurnController,
  DefaultClarifier,
  SkillRetrievalTurnDispatch,
  WorkbenchReplayRunner,
  TurnPlanCoordinator,
  TurnPlanService,
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
  AgentConverseAudit,
  AgentConverseService,
} from "../../../modules/chat/composition.js";
import {
  createDefaultConnectorRegistry,
  createDefaultChunkingStrategyRegistry,
  createDefaultDocumentJobConsumer,
  createDefaultDocumentJobDispatcher,
  createDefaultDocumentStorage,
  createDefaultWebsiteCrawlJobConsumer,
  createDefaultWebsiteCrawlJobDispatcher,
  type ApplicationComposition,
} from "../../composition/index.js";
import {
  ChunkRepository,
  type DocumentJobDispatcherPort,
  DocumentDeletionService,
  DocumentEnrichmentService,
  DocumentImportService,
  DocumentIngestionService,
  type EmbeddingCoverageReconciliationPort,
  ModelDocumentEnrichmentGateway,
  DocumentProcessingService,
  DocumentProcessingWorker,
  EmbeddingProfileJobService,
  type EmbeddingProfileTerminalFailurePort,
  DocumentSearchHistoryService,
  DocumentSearchService,
  DocumentSourceReprocessService,
  DocumentSourceContentService,
  WorkspaceIngestionReprocessService,
  AgentConverseResourceService,
} from "../../../modules/documents/composition.js";
import {
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  GatewayQueryRewritePortAdapter,
  ModelSenseLabelGateway,
  type ChunkCandidateHydratorPort,
  PgLexicalSearch,
  PostgresSenseEmbeddingReader,
  PgVectorChunkStorage,
  PromptBuilder,
  RetrievalAnswerExecutor,
  RetrievalAnswerService,
  SenseGroupingService,
  createDefaultRetrievalServices,
  AgentConverseGroundedAnswerService,
  type RetrievalSensePolicy,
  type RetrievalPipelinePort,
} from "../../../modules/retrieval/composition.js";
import type {
  ClusteringEmbeddingPort,
  DocumentEmbeddingPort,
  PinnedDocumentEmbeddingPort,
  QueryEmbeddingPort,
} from "../../../modules/embeddingProfiles/contracts/embeddingConsumers.js";
import {
  EmbeddingProfileCleanupService,
  type EmbeddingProfileProjectionCleanupPort,
} from "../../../modules/embeddingProfiles/public.js";
import type { VectorCandidateSearchPort } from "../../../modules/retrieval/domain/vectorAdapter.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { AbuseControlRepository } from "../../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../../modules/security/services/abuseControlService.js";
import {
  WorkspaceProviderCredentialsRepository,
  type WorkspaceProviderCredentialsRepositoryPort,
} from "../../../db/repositories/workspaceProviderCredentialsRepository.js";
import { WorkspaceProviderCredentialsService } from "../../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WebhookDestinationRepository } from "../../../db/repositories/webhookDestinationRepository.js";
import { CustomerEmailConnectionRepository } from "../../../db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../../db/repositories/emailSkillDefinitionRepository.js";
import { EmailSkillActivityRepository } from "../../../db/repositories/emailSkillActivityRepository.js";
import { WebhookSkillDefinitionRepository } from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import { OauthConnectionRepository } from "../../../db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../../modules/integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
} from "../../../modules/slack/public.js";
import {
  DefaultWebhookDestinationAdapter,
  WebhookDestinationService,
  FetchWebhookHttpClient,
  type WebhookDestinationPublicAdapter,
  type WebhookDestinationRepositoryPort,
  type WebhookDestinationRoutineReferencePort,
  type WebhookDestinationRuntimePort,
} from "../../../modules/webhooks/public.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../../modules/settings/composition.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../../modules/settings/composition.js";
import { WorkspaceLlmCapabilityResolver } from "../../composition/workspaceLlmCapabilityResolver.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";
import {
  embeddingModelIds,
  IngestionSettingsService,
  PlatformSettingsService,
  AgentConverseSessionService,
  type EmbeddingModelTransitionPort,
} from "../../../modules/settings/composition.js";
import type { EmbeddingModelId } from "../../../modules/settings/contracts/ingestion.js";
import {
  SkillCatalogService,
  retrievalAnswerSkillDefinition,
  routineDispatchableBuiltInSkills,
  type RoutineInvocableSkillNames,
} from "../../../modules/skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../../modules/retrieval/public.js";
import { RetrieveRoutineSkillResolver } from "../../../modules/retrieval/public.js";
import { EXTERNAL_SKILLS_ADAPTER, McpSkillExecutor } from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { buildExternalSkillsDeps } from "../../../modules/externalSkills/composition.js";
import { ExternalSkillRoutineSkillResolver } from "../../../modules/externalSkills/routineSkillResolver.js";
import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  CustomerEmailDeliveryService,
  CustomerEmailRoutineSkillResolver,
  EmailSkillExecutor,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../../modules/customerEmail/public.js";
import {
  WEBHOOK_SKILLS_ADAPTER,
  WebhookRoutineSkillResolver,
  WebhookSkillExecutor,
} from "../../../modules/webhookSkills/public.js";
import {
  SLACK_SKILLS_ADAPTER,
  SlackEscalationExecutor,
  SlackRoutineSkillResolver,
  SlackSkillDefinitionRepository,
} from "../../../modules/slackSkills/public.js";
import { NotifyExecutor, NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";
import { createRoutineTurnProvider, type RoutineTriggerEmbeddingService } from "../../../modules/routines/public.js";
import { WebsiteCrawlJobService } from "../../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../../modules/websiteCrawler/worker.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../../modules/workspace/public.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../../modules/retrieval/public.js";
import { ProductAnalyticsService } from "../../../shared/analytics/productAnalyticsService.js";
import type { OrganizationCreationGuard } from "../../../shared/domain/organizationCreationGuard.js";
import { NoopUsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import { DurableUsageEventRecorder } from "../../../shared/infra/usage/durableUsageEventRecorder.js";
import { ErrorReportingService } from "../../../shared/errors/errorReportingService.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import { Database } from "../../../shared/infra/database.js";
import { resolveLlmConfig } from "../../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import { ContextualDirectiveMatchGatewayFactory, ContextualTurnPlanGatewayFactory } from "../../../shared/infra/llm/contextualGateways.js";
import { TextGenerationClientCache } from "../../../shared/infra/llm/textClientFactory.js";
import { createMailService } from "../../../modules/mail/public.js";
import { AgentSkillRepository } from "../../../modules/agentSkills/public.js";
import { ContextVariableResolverService } from "../../../modules/context-variables/public.js";
import { SkillBackedContextResolver } from "../../composition/builtIn/contextResolverModule.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../composition/builtIn/agentSkillTurnSkillProvider.js";
import { createLogger, type AppLogger } from "../../../shared/observability/logger.js";
import { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { createPublishedRoutineRegistrationSource } from "../../composition/routineDefinitionSource.js";
import { ChatAnswerSupport, recordClarificationDecision } from "../../../modules/chat/composition.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultErrorSinks,
  createDefaultTelemetrySinks,
} from "../../composition/index.js";
import type { Env } from "../../config/env.js";
import type {
  McpConverseRouteDependencies,
  McpConverseRouteServices,
} from "../../http/routes/mcpConverseRoutes.js";
import type { ChatTurnPlanHandle } from "../../../modules/chat/services/turnPlanCoordinator.js";


import { buildInfrastructure, buildRepositories } from "./infra.js";
export const buildAccessServices = (input: {
  auditService: AuditService;
  env: Pick<Env, "WORKSPACE_TOKEN_SECRET">;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const { auditService, env, repositories } = input;
  const accessGrantService = new AccessGrantService({
    repository: repositories.accessGrantRepository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: env.WORKSPACE_TOKEN_SECRET,
    auditService,
  });
  const accountAccessService = new AccountAccessService(
    repositories.accountMembershipRepository,
    auditService,
    repositories.workspaceGrantRepository,
    repositories.workspaceRepository,
  );
  const accountInvitationService = new AccountInvitationService(
    repositories.accountInvitationRepository,
    repositories.userRepository,
    accountAccessService,
    auditService,
  );

  return {
    accessGrantService,
    accountAccessService,
    accountInvitationService,
  };
};

export const buildWorkspaceProviderCredentialsService = (input: {
  auditService: AuditPort;
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY">;
  logger: Pick<AppLogger, "warn">;
  repositories: { workspaceProviderCredentialsRepository: WorkspaceProviderCredentialsRepositoryPort };
}): WorkspaceProviderCredentialsService => {
  const service = new WorkspaceProviderCredentialsService(
    input.repositories.workspaceProviderCredentialsRepository,
    input.auditService,
    { key: input.env.CONNECTOR_ENCRYPTION_KEY },
    input.logger,
  );
  service.onDecryptError((error, provider) => {
    input.logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        provider,
        remediation:
          "Stored credential ciphertext could not be decrypted. Re-enter the API key for this provider after rotating CONNECTOR_ENCRYPTION_KEY.",
      },
      "Workspace provider credential decrypt failed",
    );
  });
  if (!service.isEncryptionConfigured()) {
    input.logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving workspace provider API keys.",
      },
      "Workspace provider credential encryption is not configured; credential writes will be rejected until this is fixed",
    );
  }
  return service;
};

export const buildWorkspaceServices = (input: {
  accountMembershipRepository: AccountMembershipRepository;
  auditService: AuditService;
  conversationRepository: ConversationRepository;
  documentRepository: DocumentRepository;
  env: Env;
  workspaceRepository: WorkspaceRepository;
}) => {
  const workspaceService = new WorkspaceService(
    input.workspaceRepository,
    input.auditService,
    input.accountMembershipRepository,
  );
  return {
    workspaceService,
    workspaceSessionService: new WorkspaceSessionService(workspaceService),
    workspaceSummaryService: new WorkspaceSummaryService(input.documentRepository, input.conversationRepository, {
      websiteCrawlerEnabled: input.env.WEBSITE_CRAWLER_ENABLED,
    }),
  };
};

export const buildAuthService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  database: Database;
  env: Env;
  organizationCreationGuard: OrganizationCreationGuard;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): AuthService =>
  new AuthService({
    env: input.env,
    accountRepository: input.repositories.accountRepository,
    userRepository: input.repositories.userRepository,
    sessionRepository: input.repositories.sessionRepository,
    workspaceTokenRepository: input.repositories.workspaceTokenRepository,
    workspaceService: input.workspaceService,
    accountAccessService: input.access.accountAccessService,
    accountInvitationService: input.access.accountInvitationService,
    onAccountCreated: input.onAccountCreated,
    organizationCreationGuard: input.organizationCreationGuard,
    organizationProvisioner: new PostgresOrganizationProvisioner(input.database, input.auditService),
    auditService: input.auditService,
  });

export const buildPasswordResetService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): PasswordResetService =>
  new PasswordResetService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    accountRepository: input.repositories.accountRepository,
    accountAccessService: input.access.accountAccessService,
    workspaceService: input.workspaceService,
    sessionRepository: input.repositories.sessionRepository,
    passwordResetTokenRepository: input.repositories.passwordResetTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
    logger: input.logger,
  });

export const buildEmailVerificationService = (input: {
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
}): EmailVerificationService =>
  new EmailVerificationService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    emailVerificationTokenRepository: input.repositories.emailVerificationTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
    logger: input.logger,
  });
