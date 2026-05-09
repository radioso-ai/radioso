import type {
  AssistantChatService,
  AssistantHistoryService,
  ChatBootstrapService,
  ChatHistoryService,
  ChatService,
} from "../../modules/chat/composition.js";
import type {
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
import type { ChatActionProviderPort, ContactHistoryProviderPort } from "../../modules/chat/contracts/index.js";
import type { UserRepositoryPort } from "../../db/repositories/userRepository.js";
import type { SkillCatalogService } from "../../modules/skills/public.js";
import type { AgentService } from "../../modules/agents/public.js";
import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { SupportImpersonationService } from "../../modules/support/services/supportImpersonationService.js";

export interface AppDependencies {
  env: Env;
  logger: AppLogger;
  metricsRegistry: MetricsRegistry | null;
  telemetryService: TelemetryService;
  incidentReportingService: IncidentReportingService;
  productAnalyticsService: ProductAnalyticsPort;
  capabilityPolicy: CapabilityPolicy;
  usageLimitPolicy: UsageLimitPolicy;
  chatActionProvider: ChatActionProviderPort;
  contactHistoryProvider: ContactHistoryProviderPort;
  applicationRouteMounts: ApplicationRouteMount[];
  applicationModules: ApplicationModuleCoordinator;
  authService: AuthService;
  accountAccessService: AccountAccessService;
  accountInvitationService: AccountInvitationService;
  supportImpersonationService: SupportImpersonationService;
  workspaceSessionService: WorkspaceSessionService;
  abuseControlService: AbuseControlService;
  auditService: AuditService;
  workspaceService: WorkspaceService;
  workspaceSummaryService: WorkspaceSummaryService;
  ingestionSettingsService: IngestionSettingsService;
  retrievalSettingsService: RetrievalSettingsService;
  documentIngestionService: DocumentIngestionService;
  documentImportService: DocumentImportService;
  documentSearchService: DocumentSearchService;
  documentSearchHistoryService: DocumentSearchHistoryService;
  workspaceIngestionReprocessService: WorkspaceIngestionReprocessService;
  documentProcessingWorker: DocumentProcessingWorker;
  documentJobConsumer?: DocumentJobConsumerPort;
  documentDeletionService: DocumentDeletionService;
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
  workspaceRepository: WorkspaceRepositoryPort;
  agentRepository: AgentRepositoryPort;
  userRepository: UserRepositoryPort;
  accountRepository: AccountRepositoryPort;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepositoryPort;
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  connectorRegistry: ConnectorRegistry;
  connectorDb: Database;
}
