import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import { AuditEventRepository } from "../../../db/repositories/auditEventRepository.js";
import { DocumentRepository } from "../../../db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../../db/repositories/documentSourceRepository.js";
import { IngestionSettingsRepository } from "../../../db/repositories/ingestionSettingsRepository.js";
import type { DocumentTypeCatalogRepository } from "../../../db/repositories/documentTypeCatalogRepository.js";
import { DocumentTypeCatalogService } from "../../../modules/documentTypes/composition.js";
import { AuditService } from "../../../modules/audit/composition.js";
import {
  createDefaultChunkingStrategyRegistry,
  createDefaultDocumentJobConsumer,
  createDefaultDocumentJobDispatcher,
  createDefaultDocumentStorage,
  createDefaultWebsiteCrawlJobConsumer,
  createDefaultWebsiteCrawlJobDispatcher,
  type ApplicationComposition,
} from "../../composition/index.js";
import {
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
} from "../../../modules/documents/composition.js";
import {
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  GatewayQueryRewritePortAdapter,
  type ChunkCandidateHydratorPort,
  PgLexicalSearch,
  PromptBuilder,
  RetrievalAnswerExecutor,
  createDefaultRetrievalServices,
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
import type { VectorCandidateSearchPort } from "../../../modules/retrieval/public.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import {
  embeddingModelIds,
  IngestionSettingsService,
  type EmbeddingModelTransitionPort,
} from "../../../modules/settings/composition.js";
import type { EmbeddingModelId } from "../../../modules/settings/contracts/ingestion.js";
import { WebsiteCrawlJobService } from "../../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../../modules/websiteCrawler/worker.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../../modules/retrieval/public.js";
import { ProductAnalyticsService } from "../../../shared/analytics/productAnalyticsService.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import { Database } from "../../../shared/infra/database.js";
import { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import { type AppLogger } from "../../../shared/observability/logger.js";
import { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type { Env } from "../../config/env.js";
import { buildInfrastructure, buildRepositories } from "./infra.js";


export const buildSettingsServices = (input: {
  auditService: AuditService;
  ingestionSettingsRepository: IngestionSettingsRepository;
  documentTypeCatalogRepository: DocumentTypeCatalogRepository;
  supportedEmbeddingModels?: readonly EmbeddingModelId[];
  embeddingTransitions?: EmbeddingModelTransitionPort;
}) => {
  const ingestionSettingsService = new IngestionSettingsService(
    input.ingestionSettingsRepository,
    input.auditService,
    input.supportedEmbeddingModels,
    input.embeddingTransitions,
  );
  const documentTypeCatalogService = new DocumentTypeCatalogService(
    input.documentTypeCatalogRepository,
    input.auditService,
  );

  return {
    ingestionSettingsService,
    documentTypeCatalogService,
  };
};

export const listSupportedEmbeddingModels = (llmRegistry: LlmProviderRegistry): readonly EmbeddingModelId[] =>
  embeddingModelIds.filter((model) => llmRegistry.canServeEmbeddingModel(model));

export const buildWorkspaceIngestionReprocessService = (input: {
  auditService: AuditService;
  documentJobDispatcher: DocumentJobDispatcherPort;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceInvalidationPublisher: WorkspaceInvalidationPublisher;
}): WorkspaceIngestionReprocessService =>
  new WorkspaceIngestionReprocessService(
    input.repositories.documentRepository,
    input.auditService,
    input.repositories.documentProcessingJobRepository,
    input.documentJobDispatcher,
    input.workspaceInvalidationPublisher,
  );

export const buildDocumentServices = (input: {
  auditService: AuditService;
  composition: ApplicationComposition;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  documentSourceRepository: DocumentSourceRepository;
  env: Env;
  logger: AppLogger;
  productAnalyticsService: ProductAnalyticsService;
  repositories: ReturnType<typeof buildRepositories>;
  auditEventRepository: AuditEventRepository;
  settings: ReturnType<typeof buildSettingsServices>;
  telemetryService: TelemetryService;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  documentEmbeddings: DocumentEmbeddingPort;
  pinnedDocumentEmbeddings?: PinnedDocumentEmbeddingPort;
  clusteringEmbeddings: ClusteringEmbeddingPort;
  llmRegistry: LlmProviderRegistry;
  workspaceIngestionReprocessService?: WorkspaceIngestionReprocessService;
  embeddingCoverage?: EmbeddingCoverageReconciliationPort;
  errorReporter: ErrorReporter;
  postJobMaintenance?: {
    run(input: {
      maxBatches: number;
      workspaceId?: string;
    }): Promise<void>;
  };
  embeddingProfileTerminalFailures?: EmbeddingProfileTerminalFailurePort;
  embeddingProfileProjectionCleanup: EmbeddingProfileProjectionCleanupPort;
  workspaceInvalidationPublisher: WorkspaceInvalidationPublisher;
}) => {
  const {
    auditService,
    composition,
    documentSourceRepository,
    env,
    logger,
    productAnalyticsService,
    repositories,
    settings,
    telemetryService,
    usageLimitPolicy,
    usageEventRecorder,
    documentEmbeddings,
    clusteringEmbeddings,
    llmRegistry,
  } = input;
  const documentStorage = composition.documentStorage ?? createDefaultDocumentStorage(env);
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentJobDispatcher =
    input.documentJobDispatcher ?? composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const websiteCrawlJobDispatcher = createDefaultWebsiteCrawlJobDispatcher(env, logger);
  const websiteCrawlerProvider = composition.websiteCrawlerProvider ?? new RadiosoCrawlerProvider();
  const chunkingStrategyRegistry = createDefaultChunkingStrategyRegistry(
    clusteringEmbeddings,
    composition.chunkingProvider,
  );
  const documentEnrichmentService = new DocumentEnrichmentService({
    gateway: new ModelDocumentEnrichmentGateway(llmRegistry.createChatInferencePipeline(usageEventRecorder)),
  });
  const documentProcessingService = new DocumentProcessingService(
    repositories.documentRepository,
    repositories.chunkRepository,
    documentEmbeddings,
    auditService,
    settings.ingestionSettingsService,
    chunkingStrategyRegistry,
    documentSourceContentService,
    logger,
    documentEnrichmentService,
    documentSourceRepository,
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    settings.documentTypeCatalogService,
    input.workspaceInvalidationPublisher,
  );
  const embeddingProfileJobService = input.pinnedDocumentEmbeddings
    ? new EmbeddingProfileJobService(
        repositories.embeddingProfileJobRepository,
        input.pinnedDocumentEmbeddings,
      )
    : undefined;
  const embeddingProfileCleanupService = new EmbeddingProfileCleanupService(
    repositories.embeddingProfileCleanupRepository,
    input.embeddingProfileProjectionCleanup,
  );
  const documentIngestionService = new DocumentIngestionService(
    repositories.documentRepository,
    auditService,
    () => repositories.documentProcessingJobRepository.getQueueSnapshot(),
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    productAnalyticsService,
    usageLimitPolicy,
    documentSourceRepository,
    input.embeddingCoverage,
    input.workspaceInvalidationPublisher,
  );
  const websiteCrawlJobService = new WebsiteCrawlJobService({
    repository: repositories.websiteCrawlJobRepository,
    dispatcher: websiteCrawlJobDispatcher,
    documentIngestionService,
    logger,
    publisher: input.workspaceInvalidationPublisher,
  });
  const documentImportService = new DocumentImportService(
    repositories.documentRepository,
    auditService,
    documentStorage,
    () => repositories.documentProcessingJobRepository.getQueueSnapshot(),
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    usageLimitPolicy,
    documentSourceRepository,
    input.workspaceInvalidationPublisher,
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    repositories.documentRepository,
    repositories.documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    logger,
    undefined,
    documentJobDispatcher,
    env.DOCUMENT_PROCESSING_JOB_LEASE_MS,
    telemetryService,
    input.errorReporter,
    embeddingProfileJobService,
    embeddingProfileCleanupService,
    input.postJobMaintenance,
    input.embeddingProfileTerminalFailures,
    input.workspaceInvalidationPublisher,
  );
  const documentJobConsumer = composition.documentJobConsumer ?? createDefaultDocumentJobConsumer(
    env,
    logger,
    documentProcessingWorker,
  );
  const websiteCrawlWorker = new WebsiteCrawlWorker({
    repository: repositories.websiteCrawlJobRepository,
    provider: websiteCrawlerProvider,
    dispatcher: websiteCrawlJobDispatcher,
    documentIngestionService,
    auditService,
    logger,
    pollIntervalMs: env.WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS,
    jobLeaseMs: env.WEBSITE_CRAWL_JOB_LEASE_MS,
    publisher: input.workspaceInvalidationPublisher,
  });
  const websiteCrawlJobConsumer = createDefaultWebsiteCrawlJobConsumer(env, logger, websiteCrawlWorker);
  const documentDeletionService = new DocumentDeletionService(
    repositories.documentRepository,
    documentStorage,
    auditService,
    composition.capabilityPolicy,
    input.workspaceInvalidationPublisher,
  );
  const workspaceIngestionReprocessService =
    input.workspaceIngestionReprocessService ??
    buildWorkspaceIngestionReprocessService({
      auditService,
      documentJobDispatcher,
      repositories,
      workspaceInvalidationPublisher: input.workspaceInvalidationPublisher,
    });
  const documentSourceReprocessService = new DocumentSourceReprocessService(
    repositories.documentRepository,
    documentSourceRepository,
    auditService,
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    input.workspaceInvalidationPublisher,
  );
  const documentSearchHistoryService = new DocumentSearchHistoryService(
    input.auditEventRepository,
    repositories.documentRepository,
  );

  return {
    documentDeletionService,
    documentImportService,
    documentIngestionService,
    documentJobConsumer,
    documentProcessingWorker,
    documentSearchHistoryService,
    documentSourceReprocessService,
    documentStorage,
    websiteCrawlJobConsumer,
    websiteCrawlJobService,
    websiteCrawlerProvider,
    websiteCrawlWorker,
    workspaceIngestionReprocessService,
  };
};

export const buildRetrievalServices = (input: {
  auditService: AuditService;
  database: Database;
  documentRepository: DocumentRepository;
  queryEmbeddings: QueryEmbeddingPort;
  vectorSearch: VectorCandidateSearchPort;
  chunkHydrator: ChunkCandidateHydratorPort;
  llmRegistry: LlmProviderRegistry;
  logger: AppLogger;
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  skillSettingsResolver?: SkillSettingsResolver;
  telemetryService: TelemetryService;
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  workspaceInvalidationPublisher: WorkspaceInvalidationPublisher;
}) => {
  const retrieval = createDefaultRetrievalServices(input);
  const retrievalPipeline = buildRetrievalAnswerExecutor(retrieval.retrievalPipeline, input);
  return {
    ...retrieval,
    retrievalPipeline,
    documentSearchService: new DocumentSearchService(
      input.documentRepository,
      retrievalPipeline,
      input.auditService,
      input.workspaceInvalidationPublisher,
    ),
  };
};

// The retrieval controller: it selects fixed vs reasoning per turn from the
// workspace's `retrievalStrategy` preference and dispatches. The reasoning
// strategy (the agent runtime) is constructed lazily so it costs nothing for
// workspaces that never select it.
const buildRetrievalAnswerExecutor = (
  deterministic: RetrievalPipelinePort,
  input: {
    queryEmbeddings: QueryEmbeddingPort;
    vectorSearch: VectorCandidateSearchPort;
    chunkHydrator: ChunkCandidateHydratorPort;
    database: Database;
    llmRegistry: LlmProviderRegistry;
    logger: AppLogger;
    telemetryService: TelemetryService;
    usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  },
): RetrievalPipelinePort =>
  new RetrievalAnswerExecutor({
    fixed: deterministic,
    reasoning: () => {
      const systemPrompt = loadPromptTemplate("agentic-retrieval/system.md");
      const runner = new AgenticRetrievalRunner({
        capabilityRunner: new AgenticCapabilityRunner({
          runtime: new DefaultAgentRuntime({ gateway: input.llmRegistry.createToolCallingGateway(input.usageEventRecorder) }),
        }),
        queryEmbeddings: input.queryEmbeddings,
        vectorSearch: input.vectorSearch,
        chunkHydrator: input.chunkHydrator,
        lexicalSearch: new PgLexicalSearch(input.database),
        queryRewrite: new GatewayQueryRewritePortAdapter(input.llmRegistry.createRewriteGateway(input.usageEventRecorder)),
        rerankGateway: input.llmRegistry.createRerankGateway(input.usageEventRecorder),
      });
      return new AgenticRetrievalPipelineService({
        deterministic,
        runner,
        promptBuilder: new PromptBuilder(),
        systemPrompt,
      });
    },
    onStrategySelected: (selection, { workspaceId }) => {
      void input.telemetryService.emit({
        eventType: "retrieval.strategy.selected",
        correlation: { workspaceId },
        metadata: {
          workspaceId,
          strategy: selection.strategy,
          selectionMode: selection.selectionMode,
          selectionReason: selection.selectionReason,
        },
        tags: { strategy: selection.strategy },
      });
    },
  });
