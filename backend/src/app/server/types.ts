import type {
  ActionDispatchWorker,
  AssistantChatService,
  AssistantHistoryService,
  ChatBootstrapService,
  ChatHistoryService,
  ChatService,
  WorkbenchReplayRunner,
} from "../../modules/chat/composition.js";
import type {
  DocumentStoragePort,
  DocumentDeletionService,
  DocumentImportService,
  DocumentIngestionService,
  DocumentProcessingWorker,
  DocumentSearchHistoryService,
  DocumentSearchService,
  WorkspaceIngestionReprocessService,
} from "../../modules/documents/composition.js";
import type { RetrievalMetadataFieldSourcePort } from "../../modules/settings/contracts/services.js";
import type { JobConsumerPort } from "../../shared/domain/jobConsumer.js";
import type { IngestionSettingsService } from "../../modules/settings/composition.js";
import type { PlatformSettingsService } from "../../modules/settings/composition.js";
import type { RetrievalAnswerService, RetrievalSearchService } from "../../modules/retrieval/composition.js";
import type { RetrievalDefaultsProvider } from "../../modules/retrieval/public.js";
import type { AuthService } from "../../modules/auth/services/authService.js";
import type { EmailVerificationService } from "../../modules/auth/services/emailVerificationService.js";
import type { PasswordResetService } from "../../modules/auth/services/passwordResetService.js";
import type { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
import type { AccessGrantService } from "../../modules/accessGrants/services/accessGrantService.js";
import type { AccountInvitationService } from "../../modules/account/services/accountInvitationService.js";
import type { AuditService } from "../../modules/audit/composition.js";
import type { WorkspaceService } from "../../modules/workspace/services/workspaceService.js";
import type { WorkspaceSummaryService } from "../../modules/workspace/services/workspaceSummaryService.js";
import type { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import type { ChunkRepositoryPort } from "../../modules/documents/contracts/index.js";
import type { WorkspaceRepositoryPort } from "../../db/repositories/workspaceRepository.js";
import type { AccountRepositoryPort } from "../../modules/auth/services/authService.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { ConnectorIngestionPort } from "@radioso/connector-api";
import type { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import type { Database } from "../../shared/infra/database.js";
import type { Env } from "../config/env.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import type { WorkspaceProviderCredentialsService } from "../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import type { WebhookDestinationService } from "../../modules/webhooks/public.js";
import type { WorkspaceLlmCapabilitySettingsService } from "../../modules/settings/composition.js";
import type { ProductAnalyticsPort } from "../../shared/analytics/productAnalyticsService.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { ErrorReportingService } from "../../shared/errors/errorReportingService.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { OrganizationCreationGuard } from "../../shared/domain/organizationCreationGuard.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { ApplicationModuleCoordinator, ApplicationRouteMount } from "../composition/applicationModule.js";
import type { PublicChatActionAdvertiserPort, ContactHistoryProviderPort } from "../../modules/chat/contracts/index.js";
import type { UserRepositoryPort } from "../../db/repositories/userRepository.js";
import type { SkillCatalogService } from "../../modules/skills/public.js";
import type { AgentService, AgentSurfaceExtensionRegistry, AuthoredDirectiveService, DirectiveAuthorService } from "../../modules/agents/public.js";
import type { RoutineDefinitionService } from "../../modules/routines/public.js";
import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { DocumentSourceRepositoryPort } from "../../db/repositories/documentSourceRepository.js";
import type { WebsiteCrawlerProvider } from "../../modules/websiteCrawler/provider.js";
import type { WebsiteCrawlJobService } from "../../modules/websiteCrawler/jobService.js";
import type { WebsiteCrawlWorker } from "../../modules/websiteCrawler/worker.js";
import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import type { EmailService } from "../../modules/mail/public.js";
import type {
  EvalCaseService,
  EvalRunService,
  EvalSnapshotService,
} from "../../modules/eval/composition.js";

export interface AppDependencies {
  env: Env;
  logger: AppLogger;
  metricsRegistry: MetricsRegistry | null;
  telemetryService: TelemetryService;
  errorReportingService: ErrorReportingService;
  productAnalyticsService: ProductAnalyticsPort;
  capabilityPolicy: CapabilityPolicy;
  usageLimitPolicy: UsageLimitPolicy;
  organizationCreationGuard: OrganizationCreationGuard;
  publicChatActionAdvertiser: PublicChatActionAdvertiserPort;
  contactHistoryProvider: ContactHistoryProviderPort;
  applicationRouteMounts: ApplicationRouteMount[];
  applicationModules: ApplicationModuleCoordinator;
  authService: AuthService;
  accessGrantService: AccessGrantService;
  passwordResetService: PasswordResetService;
  emailVerificationService: EmailVerificationService;
  accountAccessService: AccountAccessService;
  accountInvitationService: AccountInvitationService;
  workspaceSessionService: WorkspaceSessionService;
  abuseControlService: AbuseControlService;
  workspaceProviderCredentialsService: WorkspaceProviderCredentialsService;
  webhookDestinationService: WebhookDestinationService;
  workspaceLlmCapabilitySettingsService: WorkspaceLlmCapabilitySettingsService;
  auditService: AuditService;
  mailService: EmailService;
  workspaceService: WorkspaceService;
  workspaceSummaryService: WorkspaceSummaryService;
  ingestionSettingsService: IngestionSettingsService;
  chunkRepository: ChunkRepositoryPort;
  documentRepository: RetrievalMetadataFieldSourcePort;
  documentIngestionService: DocumentIngestionService;
  documentSourceRepository: DocumentSourceRepositoryPort;
  documentImportService: DocumentImportService;
  documentSearchService: DocumentSearchService;
  documentSearchHistoryService: DocumentSearchHistoryService;
  workspaceIngestionReprocessService: WorkspaceIngestionReprocessService;
  documentProcessingWorker: DocumentProcessingWorker;
  documentJobConsumer?: JobConsumerPort;
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  websiteCrawlJobService: WebsiteCrawlJobService;
  websiteCrawlWorker: WebsiteCrawlWorker;
  websiteCrawlJobConsumer?: JobConsumerPort;
  documentDeletionService: DocumentDeletionService;
  documentStorage: DocumentStoragePort;
  chatService: ChatService;
  workbenchReplayRunner: WorkbenchReplayRunner;
  // Worker-process drain loop for the async conversation-action outbox (spec 070).
  // Present in every dependency build; only the worker runtime calls start/stop.
  actionDispatchWorker: ActionDispatchWorker;
  chatBootstrapService: ChatBootstrapService;
  chatHistoryService: ChatHistoryService;
  assistantChatService: AssistantChatService;
  assistantHistoryService: AssistantHistoryService;
  retrievalSearchService: RetrievalSearchService;
  retrievalAnswerService: RetrievalAnswerService;
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  evalSnapshotService: EvalSnapshotService;
  evalCaseService: EvalCaseService;
  evalRunService: EvalRunService;
  platformSettingsService: PlatformSettingsService;
  skillCatalogService: SkillCatalogService;
  agentService: AgentService;
  authoredDirectiveService: AuthoredDirectiveService;
  routineDefinitionService: RoutineDefinitionService;
  directiveAuthorService: DirectiveAuthorService;
  agentSurfaceExtensions: AgentSurfaceExtensionRegistry;
  workspaceRepository: WorkspaceRepositoryPort;
  agentRepository: AgentRepositoryPort;
  userRepository: UserRepositoryPort;
  accountRepository: AccountRepositoryPort;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepositoryPort;
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  connectorRegistry: ConnectorRegistry;
  connectorIngestionPort: ConnectorIngestionPort;
  connectorDb: Database;
  chatInferencePipeline: ModelInferencePipeline;
  crawlerProvider: {
    fetchPageWithScreenshot(url: string, options?: {
      signal?: AbortSignal;
      validateNavigationUrl?: (url: string) => Promise<void> | void;
      [key: string]: unknown;
    }): Promise<{
      url: string;
      title: string | null;
      text: string;
      links: string[];
      screenshot: Uint8Array | null;
      faviconUrl: string | null;
    }>;
    crawlSite(params: {
      baseUrl: string;
      pageLimit: number;
      seedPendingUrls?: string[];
      includeBaseUrl?: boolean;
      signal?: AbortSignal;
    }): Promise<Array<{
      url: string;
      title: string | null;
      text: string;
      status: string;
      links?: string[];
      httpStatus?: number | null;
      error?: string | null;
    }>>;
    isBrowserTransportAvailable(): Promise<boolean>;
  };
  assertPublicWebsiteUrl: (url: string) => Promise<void>;
  websiteCrawlerLimits: {
    defaultLimit: number;
    maxLimit: number;
  };
}
