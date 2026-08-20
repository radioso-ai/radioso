import {
  createDefaultDocumentJobDispatcher,
  createRetrievalSkillSettingsResolver,
  createSystemRetrievalDefaultsProvider,
  EmbeddingModelTransitionAdapter,
  EmbeddingProfileJobFailureAdapter,
  LegacyVectorCandidateSearchAdapter,
  PgVectorTransitionIndexPreparation,
  PgVectorTransitionMaintenance,
  RegistryFixedInputEmbeddingValidation,
  VectorCandidateSearchRolloutAdapter,
  WorkspaceEmbeddingBindingResolver,
  type ApplicationComposition,
} from "../../composition/index.js";
import {
  EmbeddingCoverageReconciler,
  EmbeddingTransitionCoordinator,
  ProfileBoundEmbeddingPorts,
} from "../../../modules/embeddingProfiles/public.js";
import { resolveLlmConfig } from "../../../shared/infra/llm/providerConfig.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { PgVectorAdapter, PgVectorIndex, PostgresChunkCandidateHydrator, VectorIndexReconciler } from "../../../modules/retrieval/composition.js";
import { buildInfrastructure, buildRepositories } from "./infra.js";
import {
  buildDocumentServices,
  buildRetrievalServices,
  buildSettingsServices,
  buildWorkspaceIngestionReprocessService,
  listSupportedEmbeddingModels,
} from "./documentsRetrieval.js";
import {
  buildLlmCapabilityResolver,
  buildLlmRegistry,
  buildWorkspaceLlmCapabilitySettingsService,
} from "./integrations.js";
import { buildWorkspaceServices } from "./accessAuth.js";
import type { WorkspaceProviderCredentialsService } from "../../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import type { Env } from "../../config/env.js";

/** Composes the embedding transition, document, and retrieval graph in dependency order. */
export const buildDocumentRetrievalGraph = (input: {
  composition: ApplicationComposition;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceProviderCredentialsService: WorkspaceProviderCredentialsService;
}) => {
  const { composition, env, infrastructure, logger, repositories } = input;
  const llmRegistry = buildLlmRegistry(env, logger);
  const documentJobDispatcher = composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const workspaceIngestionReprocessService = buildWorkspaceIngestionReprocessService({
    auditService: infrastructure.auditService,
    documentJobDispatcher,
    repositories,
  });
  const embeddingCoverage = new EmbeddingCoverageReconciler(
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
  );
  const pgVectorAdapter = new PgVectorAdapter(infrastructure.database);
  const embeddingTransitionCoordinator = new EmbeddingTransitionCoordinator(
    repositories.embeddingProfileRepository,
    new RegistryFixedInputEmbeddingValidation(repositories.embeddingProfileRepository, llmRegistry),
    embeddingCoverage,
    {
      backendKey: "pgvector",
      onTransitionBlocked: (transition) => {
        logger.warn(
          {
            event: "embedding.transition.blocked",
            backend: transition.backendKey,
            workspaceId: transition.workspaceId,
            embeddingTransitionId: transition.transitionId,
            embeddingSpaceId: transition.targetEmbeddingSpaceId,
            failureReason: transition.failureReason,
          },
          "Embedding transition blocked after vector index retry exhaustion",
        );
      },
    },
  );
  const embeddingTransitions = new EmbeddingModelTransitionAdapter(
    repositories.embeddingProfileRepository,
    (model) => llmRegistry.resolveEmbeddingModelBinding(model),
    embeddingTransitionCoordinator,
    new PgVectorTransitionIndexPreparation(pgVectorAdapter, repositories.vectorIndexWorkRepository),
  );
  const embeddingProfileJobFailures = new EmbeddingProfileJobFailureAdapter(
    repositories.embeddingProfileRepository,
    embeddingTransitionCoordinator,
  );
  const settings = buildSettingsServices({
    auditService: infrastructure.auditService,
    ingestionSettingsRepository: repositories.ingestionSettingsRepository,
    supportedEmbeddingModels: listSupportedEmbeddingModels(llmRegistry),
    embeddingTransitions,
  });
  let vectorTransitionMaintenance: PgVectorTransitionMaintenance;
  const vectorIndexReconciler = new VectorIndexReconciler({
    adapter: pgVectorAdapter,
    backendKey: "pgvector",
    repository: repositories.vectorIndexWorkRepository,
    spaces: repositories.embeddingProfileRepository,
    batchSize: 100,
    leaseMs: 60_000,
    maxAttempts: 5,
    retryDelayMs: 5_000,
    pollIntervalMs: 1_000,
    resolveCaughtUpReadiness: async () => "exact_fallback",
    onCheckpointAdvanced: async ({ workspaceId }) => {
      await settings.ingestionSettingsService.promotePendingEmbeddingModelIfReady?.(workspaceId);
    },
    onIdle: () => vectorTransitionMaintenance.reconcileBuildingTransitions(),
    onLoopError: (error) => {
      logger.error(
        { backend: "pgvector", err: error instanceof Error ? error.message : String(error) },
        "Vector index reconciliation tick failed",
      );
      void infrastructure.errorReportingService.report({
        errorType: "vector.index.reconciliation_tick_failed",
        error,
        severity: "error",
      }).catch((reportError) => {
        logger.error(
          { err: reportError instanceof Error ? reportError.message : String(reportError) },
          "Vector index reconciliation error report failed",
        );
      });
    },
  });
  vectorTransitionMaintenance = new PgVectorTransitionMaintenance(
    vectorIndexReconciler,
    repositories.embeddingProfileRepository,
    {
      reconcileBackfills: (transition) => embeddingTransitionCoordinator.reconcileBackfills(transition),
      promotePendingEmbeddingModelIfReady: (workspaceId) =>
        settings.ingestionSettingsService.promotePendingEmbeddingModelIfReady!(workspaceId),
    },
    (outcome) => {
      logger.warn(
        {
          role: "worker",
          embeddingTransitionsDiscovered: outcome.discovered,
          embeddingTransitionBackfillHandoffsFailed: outcome.failed,
        },
        "Embedding transition backfill reconciliation incomplete",
      );
    },
  );
  const embeddingBindingResolver = new WorkspaceEmbeddingBindingResolver({
    profiles: repositories.embeddingProfileRepository,
    settings: settings.ingestionSettingsService,
    identifyModel: (model) => llmRegistry.resolveEmbeddingModelBinding(model),
  });
  const embeddingPorts = new ProfileBoundEmbeddingPorts(
    llmRegistry.createEmbeddingGateway(infrastructure.usageEventRecorder),
    embeddingBindingResolver,
  );
  const chunkHydrator = new PostgresChunkCandidateHydrator(infrastructure.database.kysely);
  const vectorSearch = new VectorCandidateSearchRolloutAdapter({
    canonical: pgVectorAdapter.search,
    legacy: new LegacyVectorCandidateSearchAdapter({
      legacy: new PgVectorIndex(infrastructure.database),
      profiles: repositories.embeddingProfileRepository,
    }),
    legacyDimensions: [1536, 3072],
  });
  const workspaceLlmCapabilitySettingsService = buildWorkspaceLlmCapabilitySettingsService({
    auditService: infrastructure.auditService,
    capabilityRepository: repositories.retrievalSettingsRepository,
    logger,
  });
  const llmCapabilityResolver = buildLlmCapabilityResolver({
    env,
    defaults: resolveLlmConfig(env),
    settings: workspaceLlmCapabilitySettingsService,
    credentials: input.workspaceProviderCredentialsService,
  });
  llmRegistry.setResolver(llmCapabilityResolver);
  const documents = buildDocumentServices({
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    composition,
    documentJobDispatcher,
    documentSourceRepository: repositories.documentSourceRepository,
    documentEmbeddings: embeddingPorts,
    pinnedDocumentEmbeddings: embeddingPorts,
    clusteringEmbeddings: embeddingPorts,
    env,
    logger,
    productAnalyticsService: infrastructure.productAnalyticsService,
    postJobMaintenance: vectorTransitionMaintenance,
    repositories,
    settings,
    telemetryService: infrastructure.telemetryService,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    usageEventRecorder: infrastructure.usageEventRecorder,
    llmRegistry,
    workspaceIngestionReprocessService,
    embeddingCoverage,
    errorReporter: infrastructure.errorReportingService,
    embeddingProfileTerminalFailures: embeddingProfileJobFailures,
    embeddingProfileProjectionCleanup: {
      resetWorkspaceSpace: ({ workspaceId, embeddingSpaceId }) =>
        pgVectorAdapter.admin.resetSpace({ workspaceId, spaceId: embeddingSpaceId }),
      dropUnusedIndexes: () => pgVectorAdapter.admin.dropUnusedIndexes(),
    },
  });
  const retrievalDefaultsProvider = createSystemRetrievalDefaultsProvider();
  const skillSettingsResolver = createRetrievalSkillSettingsResolver();
  const retrieval = buildRetrievalServices({
    auditService: infrastructure.auditService,
    database: infrastructure.database,
    documentRepository: repositories.documentRepository,
    queryEmbeddings: embeddingPorts,
    vectorSearch,
    chunkHydrator,
    llmRegistry,
    logger,
    retrievalDefaultsProvider,
    skillSettingsResolver,
    telemetryService: infrastructure.telemetryService,
    usageEventRecorder: infrastructure.usageEventRecorder,
  });
  const workspace = buildWorkspaceServices({
    accountMembershipRepository: repositories.accountMembershipRepository,
    auditService: infrastructure.auditService,
    conversationRepository: repositories.conversationRepository,
    documentRepository: repositories.documentRepository,
    env,
    workspaceRepository: repositories.workspaceRepository,
  });
  return {
    documentJobDispatcher,
    documents,
    embeddingBindingResolver,
    embeddingPorts,
    llmCapabilityResolver,
    llmRegistry,
    retrieval,
    retrievalDefaultsProvider,
    settings,
    skillSettingsResolver,
    vectorIndexReconciler,
    workspace,
    workspaceIngestionReprocessService,
    workspaceLlmCapabilitySettingsService,
  };
};
