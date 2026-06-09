import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { createMailService } from "../../src/modules/mail/public.js";
import { randomUUID } from "node:crypto";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../src/modules/accessGrants/public.js";
import { AccountInvitationService } from "../../src/modules/account/services/accountInvitationService.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { EmailVerificationService } from "../../src/modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../src/modules/auth/services/passwordResetService.js";
import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import type { WorkbenchReplayRunner } from "../../src/modules/chat/composition.js";
import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { ActionDispatchWorker } from "../../src/modules/chat/services/actions/actionDispatchWorker.js";
import { createConversationEngine } from "@radioso/conversation-engine";
import { scopeTag } from "@radioso/conversation-defaults";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { createSkillOutcomeCapabilityProvider } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { AssistantChatService } from "../../src/modules/chat/services/assistantChatService.js";
import { AssistantHistoryService } from "../../src/modules/chat/services/assistantHistoryService.js";
import { AgentService, AgentSurfaceExtensionRegistry, AuthoredDirectiveService, DirectiveAuthorService } from "../../src/modules/agents/public.js";
import {
  type FallbackReplyComposer,
} from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { DocumentSearchHistoryService } from "../../src/modules/documents/services/documentSearchHistoryService.js";
import { DocumentSearchService } from "../../src/modules/documents/services/documentSearchService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
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
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import { streamResult, textResult } from "./llmStubs.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { PlatformSettingsService } from "../../src/modules/settings/services/platformSettingsService.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/public.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { WorkspaceSummaryService } from "../../src/modules/workspace/services/workspaceSummaryService.js";
import { WorkspaceSessionService } from "../../src/modules/auth/services/workspaceSessionService.js";
import { ConnectorRegistry } from "../../src/modules/connectors/services/connectorRegistry.js";
import { createConnectorChatPort } from "../../src/modules/connectors/services/connectorChatPort.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { WorkspaceProviderCredentialsService } from "../../src/modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../src/modules/settings/services/workspaceLlmCapabilitySettingsService.js";
import { buildAnalyticsSinks } from "../../src/shared/analytics/buildAnalyticsSinks.js";
import { ProductAnalyticsService } from "../../src/shared/analytics/productAnalyticsService.js";
import { buildErrorSinks } from "../../src/shared/errors/buildErrorSinks.js";
import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { buildTelemetrySinks } from "../../src/shared/observability/telemetry/buildTelemetrySinks.js";
import { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import {
  EvalCaseService,
  EvalRepository,
  EvalRunService,
  EvalSnapshotService,
} from "../../src/modules/eval/composition.js";
import { ApplicationModuleCoordinator, createApplicationExtensionRegistry } from "../../src/app/composition/applicationModule.js";
import {
  createDefaultAgentSkillSettingsRegistry,
  createRetrievalSkillSettingsResolver,
  createSystemRetrievalDefaultsProvider,
} from "../../src/app/composition/index.js";
import { DefaultAllowCapabilityPolicy, registeredCapabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import {
  noopOrganizationCreationGuard,
  type OrganizationCreationGuard,
} from "../../src/shared/domain/organizationCreationGuard.js";
import {
  ChainedPublicChatActionAdvertiser,
  NoopPublicChatActionAdvertiser,
  type PublicChatActionAdvertiserPort,
} from "../../src/modules/chat/services/publicChatActionAdvertiser.js";
import { NoopContactHistoryProvider } from "../../src/modules/chat/services/contactHistoryProvider.js";
import type { AnswerFeedbackHistoryProviderPort } from "../../src/modules/chat/services/answerFeedbackHistoryProvider.js";
import {
  createDefaultSkillCatalogRegistry,
  SkillCatalogService,
} from "../../src/modules/skills/public.js";
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
} from "./fakes.js";

export const createTestEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8080,
  OBSERVABILITY_ENABLED: true,
  OBSERVABILITY_SERVICE_NAME: "radioso-api",
  OBSERVABILITY_ENVIRONMENT: "test",
  OBSERVABILITY_VERSION: "test",
  METRICS_ENABLED: false,
  METRICS_PATH: "/metrics",
  METRICS_AUTH_TOKEN: undefined,
  OTEL_ENABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
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
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  EE_MAX_ORGS_PER_USER_PER_MONTH: 10,
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
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "test-document-imports",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  WORKER_DISPATCH_DRIVER: "noop",
  WORKER_TASKS_QUEUE_LOCATION: undefined,
  WORKER_TASKS_QUEUE_NAME: undefined,
  WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
  WORKER_TASKS_SERVICE_URL: undefined,
  WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
  WORKER_AMQP_URL: undefined,
  WORKER_AMQP_QUEUE_NAME: undefined,
  WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
  WORKER_AMQP_PREFETCH: 1,
  DOCUMENT_PROCESSING_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWL_JOB_LEASE_MS: 900_000,
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: 5_000,
  WEBSITE_CRAWLER_ENABLED: true,
  APP_BASE_URL: undefined,
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
  messageRepository: InMemoryMessageRepository;
  agentRepository: InMemoryAgentRepository;
}

const appDependencyMap = new WeakMap<object, AppDependencies>();
const appRepositoryMap = new WeakMap<object, TestRepositories>();

class TestFallbackReplyComposer implements FallbackReplyComposer {
  async composeNoContext(): Promise<string> {
    return "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.";
  }
}

export const createTestDependencies = (overrides: {
  chatGateway?: ChatGateway;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  triggerAnalysisGateway?: TriggerAnalysisGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  fallbackReplyComposer?: FallbackReplyComposer;
  usageLimitPolicy?: UsageLimitPolicy;
  organizationCreationGuard?: OrganizationCreationGuard;
  answerFeedbackHistoryProvider?: AnswerFeedbackHistoryProviderPort;
  publicChatActionAdvertiser?: PublicChatActionAdvertiserPort;
  applicationRouteMounts?: ApplicationRouteMount[];
  workbenchReplayRunner?: Pick<WorkbenchReplayRunner, "run">;
  chatInferencePipelineComplete?: AppDependencies["chatInferencePipeline"]["complete"];
  logger?: AppDependencies["logger"];
} = {}): { dependencies: AppDependencies; repositories: TestRepositories } => {
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
  const messageRepository = new InMemoryMessageRepository();
  conversationRepository.setMessageRepository(messageRepository);
  const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
  const embeddingGateway: EmbeddingGateway = {
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
  const embeddingService = new EmbeddingService({
    async embedTexts(texts: string[]): Promise<number[][]> {
      currentQueryText = texts[0] ?? "";
      return embeddingGateway.embedTexts(texts);
    },
  });
  const chunkingProvider = new ChonkieChunkingProvider(embeddingService);
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
  const ingestionSettingsService = new IngestionSettingsService(
    ingestionSettingsRepository,
    auditService,
    documentRepository,
    undefined,
    workspaceIngestionReprocessService,
  );
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentProcessingService = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    embeddingService,
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
      throw new Error("Workbench replay runner is not configured in test app.");
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
    embeddingService,
    vectorSearch,
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
    ingestionSettingsService,
    createRetrievalSkillSettingsResolver(),
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
  const workspaceLlmCapabilitySettingsService = new WorkspaceLlmCapabilitySettingsService(
    retrievalSettingsRepository,
    auditService,
  );
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.setEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY!);
  const connectorDb = new InMemoryConnectorDatabase();
  const agentRepository = new InMemoryAgentRepository(createDefaultAgentSkillSettingsRegistry());
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
    new NoopContactHistoryProvider(),
    overrides.answerFeedbackHistoryProvider,
  );
  const publicChatActionAdvertisers = [
    ...(overrides.publicChatActionAdvertiser ? [overrides.publicChatActionAdvertiser] : []),
  ];
  const publicChatActionAdvertiser = publicChatActionAdvertisers.length === 0
    ? new NoopPublicChatActionAdvertiser()
    : publicChatActionAdvertisers.length === 1
      ? publicChatActionAdvertisers[0]!
      : new ChainedPublicChatActionAdvertiser(publicChatActionAdvertisers);
  const skillCatalogRegistry = createDefaultSkillCatalogRegistry();
  const fallbackReplyComposer = overrides.fallbackReplyComposer ?? new TestFallbackReplyComposer();
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
    usageLimitPolicy,
    agentService,
    conversationEngine: createConversationEngine(),
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
  // The action outbox drain never runs in tests; a no-op dispatcher satisfies the shape.
  const actionDispatchWorker = new ActionDispatchWorker(
    { dispatchPending: async () => ({ dispatched: 0, retried: 0, failed: 0 }) },
    { logger },
  );
  const assistantHistoryService = new AssistantHistoryService(chatHistoryService);
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline);
  const retrievalAnswerService = new RetrievalAnswerService({
    retrievalPipeline,
    chatGateway,
    usageLimitPolicy,
    auditService,
  });
  const capabilityPolicy = new DefaultAllowCapabilityPolicy();
  const skillCatalogService = new SkillCatalogService({
    capabilityPolicy,
    registry: skillCatalogRegistry,
  });
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository,
    auditService,
    agentService,
    accessGrantService,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
  });
  const retrievalDefaultsProvider = createSystemRetrievalDefaultsProvider();
  const dependencies: AppDependencies = {
    env,
    logger,
    metricsRegistry,
    telemetryService,
    errorReportingService: persistentErrorReportingService,
    productAnalyticsService,
    capabilityPolicy,
    usageLimitPolicy,
    organizationCreationGuard,
    publicChatActionAdvertiser,
    contactHistoryProvider: new NoopContactHistoryProvider(),
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
    workspaceLlmCapabilitySettingsService,
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
    chunkRepository,
    documentRepository,
    documentIngestionService,
    documentSourceRepository,
    documentImportService,
    documentSearchService,
    documentSearchHistoryService,
    workspaceIngestionReprocessService,
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
    workbenchReplayRunner: workbenchReplayRunner as any,
    actionDispatchWorker,
    chatBootstrapService,
    chatHistoryService,
    assistantChatService,
    assistantHistoryService,
    retrievalSearchService,
    retrievalAnswerService,
    retrievalDefaultsProvider,
    evalSnapshotService: new EvalSnapshotService(
      conversationRepository,
      messageRepository,
      agentRepository,
      retrievalDefaultsProvider,
      createRetrievalSkillSettingsResolver(),
      new EvalRepository(connectorDb as any),
    ),
    evalCaseService: new EvalCaseService(new EvalRepository(connectorDb as any)),
    evalRunService: new EvalRunService(
      new EvalRepository(connectorDb as any),
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
    ),
    platformSettingsService,
    agentService,
    authoredDirectiveService,
    directiveAuthorService,
    agentSurfaceExtensions,
    skillCatalogService,
    accountRepository,
    userRepository,
    workspaceRepository,
    agentRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    messageRepository,
    connectorRegistry,
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
      messageRepository,
      agentRepository,
    },
  };
};

export const createTestApp = (overrides: {
  chatGateway?: ChatGateway;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  triggerAnalysisGateway?: TriggerAnalysisGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  fallbackReplyComposer?: FallbackReplyComposer;
  usageLimitPolicy?: UsageLimitPolicy;
  organizationCreationGuard?: OrganizationCreationGuard;
  answerFeedbackHistoryProvider?: AnswerFeedbackHistoryProviderPort;
  publicChatActionAdvertiser?: PublicChatActionAdvertiserPort;
  applicationRouteMounts?: ApplicationRouteMount[];
  workbenchReplayRunner?: Pick<WorkbenchReplayRunner, "run">;
  chatInferencePipelineComplete?: AppDependencies["chatInferencePipeline"]["complete"];
  logger?: AppDependencies["logger"];
} = {}) => {
  const { dependencies, repositories } = createTestDependencies(overrides);
  const app = createApp(dependencies);
  appDependencyMap.set(app, dependencies);
  appRepositoryMap.set(app, repositories);
  return {
    app,
    dependencies,
    repositories,
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
