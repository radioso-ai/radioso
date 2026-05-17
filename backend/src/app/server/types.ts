import type {
  AssistantChatService,
  AssistantHistoryService,
  ChatBootstrapService,
  ChatHistoryService,
  ChatService,
} from "../../modules/chat/composition.js";
import type {
  DocumentStoragePort,
  DocumentDeletionService,
  DocumentImportService,
  DocumentIngestionService,
  DocumentJobConsumerPort,
  DocumentProcessingWorker,
  DocumentSearchHistoryService,
  DocumentSearchService,
  WorkspaceIngestionReprocessService,
} from "../../modules/documents/composition.js";
import type { IngestionSettingsService } from "../../modules/settings/composition.js";
import type { PlatformSettingsService } from "../../modules/settings/composition.js";
import type { RetrievalSettingsService } from "../../modules/settings/composition.js";
import type { RetrievalAnswerService, RetrievalSearchService } from "../../modules/retrieval/composition.js";
import type { AuthService } from "../../modules/auth/services/authService.js";
import type { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
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
import type { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import type { Database } from "../../shared/infra/database.js";
import type { Env } from "../config/env.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import type { ProductAnalyticsPort } from "../../shared/analytics/productAnalyticsService.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { IncidentReportingService } from "../../shared/incidents/incidentReportingService.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { ApplicationModuleCoordinator, ApplicationRouteMount } from "../composition/applicationModule.js";
import type { ChatIntakeProviderPort, ContactHistoryProviderPort } from "../../modules/chat/contracts/index.js";
import type { UserRepositoryPort } from "../../db/repositories/userRepository.js";
import type { SkillCatalogService } from "../../modules/skills/public.js";
import type { AgentService, AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { DocumentSourceRepositoryPort } from "../../db/repositories/documentSourceRepository.js";
import type { WebsiteCrawlerProvider } from "../../modules/websiteCrawler/provider.js";
import type { WebsiteCrawlJobService } from "../../modules/websiteCrawler/jobService.js";
import type { WebsiteCrawlWorker } from "../../modules/websiteCrawler/worker.js";
import type { TextGenerationClient } from "../../shared/infra/llm/providerTypes.js";

export interface AppDependencies {
  env: Env;
  logger: AppLogger;
  metricsRegistry: MetricsRegistry | null;
  telemetryService: TelemetryService;
  incidentReportingService: IncidentReportingService;
  productAnalyticsService: ProductAnalyticsPort;
  capabilityPolicy: CapabilityPolicy;
  usageLimitPolicy: UsageLimitPolicy;
  chatIntakeProvider: ChatIntakeProviderPort;
  contactHistoryProvider: ContactHistoryProviderPort;
  applicationRouteMounts: ApplicationRouteMount[];
  applicationModules: ApplicationModuleCoordinator;
  authService: AuthService;
  accountAccessService: AccountAccessService;
  accountInvitationService: AccountInvitationService;
  workspaceSessionService: WorkspaceSessionService;
  abuseControlService: AbuseControlService;
  auditService: AuditService;
  workspaceService: WorkspaceService;
  workspaceSummaryService: WorkspaceSummaryService;
  ingestionSettingsService: IngestionSettingsService;
  retrievalSettingsService: RetrievalSettingsService;
  chunkRepository: ChunkRepositoryPort;
  documentIngestionService: DocumentIngestionService;
  documentSourceRepository: DocumentSourceRepositoryPort;
  documentImportService: DocumentImportService;
  documentSearchService: DocumentSearchService;
  documentSearchHistoryService: DocumentSearchHistoryService;
  workspaceIngestionReprocessService: WorkspaceIngestionReprocessService;
  documentProcessingWorker: DocumentProcessingWorker;
  documentJobConsumer?: DocumentJobConsumerPort;
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  websiteCrawlJobService: WebsiteCrawlJobService;
  websiteCrawlWorker: WebsiteCrawlWorker;
  websiteCrawlJobConsumer?: DocumentJobConsumerPort;
  documentDeletionService: DocumentDeletionService;
  documentStorage: DocumentStoragePort;
  chatService: ChatService;
  chatBootstrapService: ChatBootstrapService;
  chatHistoryService: ChatHistoryService;
  assistantChatService: AssistantChatService;
  assistantHistoryService: AssistantHistoryService;
  retrievalSearchService: RetrievalSearchService;
  retrievalAnswerService: RetrievalAnswerService;
  platformSettingsService: PlatformSettingsService;
  skillCatalogService: SkillCatalogService;
  agentService: AgentService;
  agentSurfaceExtensions: AgentSurfaceExtensionRegistry;
  workspaceRepository: WorkspaceRepositoryPort;
  agentRepository: AgentRepositoryPort;
  userRepository: UserRepositoryPort;
  accountRepository: AccountRepositoryPort;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepositoryPort;
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  connectorRegistry: ConnectorRegistry;
  connectorDb: Database;
  chatTextGenerationClient: TextGenerationClient;
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
