import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { randomUUID } from "node:crypto";

import { AuthService } from "../../src/modules/auth/services/authService.js";
import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
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
import { StructuredSemanticChunkingStrategy, type ChunkingSimilarityPort } from "../../src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";
import type { LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { AttributeMatchScoringService } from "../../src/modules/retrieval/services/attributeMatchScoringService.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { QueryRewriteService, type QueryRewriteGateway } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService, type RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { WorkspaceSessionService } from "../../src/modules/auth/services/workspaceSessionService.js";
import { ConnectorRegistry } from "../../src/modules/connectors/services/connectorRegistry.js";
import { createConnectorChatPort } from "../../src/modules/connectors/services/connectorChatPort.js";
import { WhatsAppPlugin } from "../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { AbuseControlRepositoryPort } from "../../src/db/repositories/abuseControlRepository.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryAccountRepository,
  InMemoryWorkspaceTokenRepository,
  InMemoryChunkRepository,
  InMemoryConversationRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentStorage,
  InMemoryDocumentProcessingJobRepository,
  InMemoryIngestionSettingsRepository,
  InMemoryMessageRepository,
  InMemoryRetrievalSettingsRepository,
  InMemorySessionRepository,
  InMemoryWorkspaceRepository,
  InMemoryConnectorDatabase,
  InMemoryAbuseControlRepository,
} from "./fakes.js";

export const createTestEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8080,
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5-mini",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_NAME: "radioso_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_HOURS: 168,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  DOCUMENT_STORAGE_BUCKET: "test-document-imports",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
});

interface TestRepositories {
  ingestionSettingsRepository: InMemoryIngestionSettingsRepository;
  retrievalSettingsRepository: InMemoryRetrievalSettingsRepository;
  documentRepository: InMemoryDocumentRepository;
  chunkRepository: InMemoryChunkRepository;
  documentProcessingJobRepository: InMemoryDocumentProcessingJobRepository;
}

const appDependencyMap = new WeakMap<object, AppDependencies>();

export const createTestDependencies = (overrides: {
  chatGateway?: ChatGateway;
  chunkingSimilarityPort?: ChunkingSimilarityPort;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  whatsappFetch?: typeof fetch;
  whatsappDebounceMs?: number;
} = {}): { dependencies: AppDependencies; repositories: TestRepositories } => {
  const env = {
    ...createTestEnv(),
    ...overrides.envOverrides,
  } satisfies Env;
  const auditEventRepository = new InMemoryAuditEventRepository();
  const auditService = createAuditService(auditEventRepository);
  const accountRepository = new InMemoryAccountRepository();
  const sessionRepository = new InMemorySessionRepository();
  const workspaceTokenRepository = new InMemoryWorkspaceTokenRepository();
  const ingestionSettingsRepository = new InMemoryIngestionSettingsRepository();
  const retrievalSettingsRepository = new InMemoryRetrievalSettingsRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const documentProcessingJobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(documentProcessingJobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const documentStorage = new InMemoryDocumentStorage();
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
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
  const chunkingSimilarityPort =
    overrides.chunkingSimilarityPort ??
    ({
      async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map((text) => keywordEmbedding(text));
      },
    } satisfies ChunkingSimilarityPort);
  const chunkingStrategyRegistry = new ChunkingStrategyRegistry([
    new FixedWindowChunkingStrategy(),
    new StructuredSemanticChunkingStrategy(chunkingSimilarityPort),
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
  const defaultRerankGateway: RerankGateway = {
    async rerank(input) {
      return input.contexts.map((context) => ({
        chunkId: context.chunkId,
        relevanceScore: keywordScore(`${context.title} ${context.content}`, input.query),
      }));
    },
  };
  const rerankGateway = overrides.rerankGateway ?? defaultRerankGateway;
  const ingestionSettingsService = new IngestionSettingsService(ingestionSettingsRepository, auditService);
  const retrievalSettingsService = new RetrievalSettingsService(
    retrievalSettingsRepository,
    auditService,
    documentRepository,
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
  );
  const documentIngestionService = new DocumentIngestionService(
    documentRepository,
    auditService,
    () => documentProcessingJobRepository.getQueueSnapshot(),
  );
  const documentImportService = new DocumentImportService(
    documentRepository,
    auditService,
    documentStorage,
    () => documentProcessingJobRepository.getQueueSnapshot(),
  );
  const workspaceIngestionReprocessService = new WorkspaceIngestionReprocessService(documentRepository, auditService);
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
    retrievalSettingsService,
    embeddingService,
    vectorSearch,
    lexicalSearch,
    new ConversationContextService(),
    new QueryRewriteService(queryRewriteGateway),
    new CandidatePreparationService(),
    new AttributeMatchScoringService(),
    new RerankService(rerankGateway),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
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
      const warmthMatch = input.prompt.match(/Warmth:(\d+)/);
      const warmthLevel = warmthMatch ? Number(warmthMatch[1]) : 5;
      const firstContext = input.prompt
        .match(/Result 1 \([^)]+\): ([\s\S]*?)(?:\n\n|$)/)?.[1]
        ?.trim();

      if (firstContext) {
        return `Warmth:${warmthLevel} ${firstContext}[[1]]`.trim();
      }

      return `Warmth:${warmthLevel} history:${input.history.length} ${input.query}`.trim();
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

  const workspaceRepository = new InMemoryWorkspaceRepository();
  const workspaceService = new WorkspaceService(workspaceRepository, auditService);
  const workspaceSessionService = new WorkspaceSessionService(workspaceService);
  const abuseControlService = new AbuseControlService(
    overrides.abuseControlRepository ?? new InMemoryAbuseControlRepository(),
  );
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.register(new WhatsAppPlugin({
    fetch: overrides.whatsappFetch,
    debounceMs: overrides.whatsappDebounceMs,
  }));
  connectorRegistry.setEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY!);
  const connectorDb = new InMemoryConnectorDatabase();

  const dependencies: AppDependencies = {
    env,
    logger: createLogger("silent"),
    auditService,
    workspaceSessionService,
    abuseControlService,
    authService: new AuthService({
      env,
      auditService,
      accountRepository,
      sessionRepository,
      workspaceTokenRepository,
      workspaceService,
    }),
    workspaceService,
    ingestionSettingsService,
    retrievalSettingsService,
    documentIngestionService,
    documentImportService,
    documentSearchService,
    documentSearchHistoryService,
    workspaceIngestionReprocessService,
    documentProcessingWorker,
    documentDeletionService,
    chatService: new ChatService(
      conversationRepository,
      messageRepository,
      retrievalPipeline,
      chatGateway,
      auditService,
    ),
    chatHistoryService: new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditEventRepository,
    ),
    workspaceRepository,
    conversationRepository,
    messageRepository,
    connectorRegistry,
    connectorDb: connectorDb as any,
  };

  void connectorRegistry.initializeAll({
    db: connectorDb as any,
    logger: dependencies.logger,
    chat: createConnectorChatPort(dependencies.chatService),
  });

  return {
    dependencies,
    repositories: {
      ingestionSettingsRepository,
      retrievalSettingsRepository,
      documentRepository,
      chunkRepository,
      documentProcessingJobRepository,
    },
  };
};

export const createTestApp = (overrides: {
  chatGateway?: ChatGateway;
  chunkingSimilarityPort?: ChunkingSimilarityPort;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  rerankGateway?: RerankGateway;
  envOverrides?: Partial<Env>;
  abuseControlRepository?: AbuseControlRepositoryPort;
  whatsappFetch?: typeof fetch;
  whatsappDebounceMs?: number;
} = {}) => {
  const { dependencies, repositories } = createTestDependencies(overrides);
  const app = createApp(dependencies);
  appDependencyMap.set(app, dependencies);
  return {
    app,
    dependencies,
    repositories,
  };
};

/**
 * Registers a test user, lists workspaces, and issues a workspace token.
 * Returns both the bearer token and the session cookie.
 */
export const issueTestToken = async (
  app: ReturnType<typeof createTestApp>["app"],
  email = `test-${randomUUID()}@example.com`,
): Promise<{ token: string; cookie: string; workspaceId: string }> => {
  const register = await request(app).post("/api/v1/auth/register").send({
    email,
    password: "verysecurepassword",
  });
  const cookie: string = register.headers["set-cookie"][0];

  const workspaces = await request(app)
    .get("/api/v1/workspace")
    .set("Cookie", cookie);
  const workspaceId: string = workspaces.body.workspaces[0].id;
  const dependencies = appDependencyMap.get(app);
  if (!dependencies) {
    throw new Error("Test app dependencies were not registered for token issuance");
  }

  const tokenResponse = await dependencies.authService.getTokenForWorkspace(workspaceId, register.body.userId as string);

  return { token: tokenResponse.token, cookie, workspaceId };
};

export const issueTestSession = async (
  app: ReturnType<typeof createTestApp>["app"],
  email = `test-${randomUUID()}@example.com`,
): Promise<{ cookie: string; workspaceId: string; userId: string }> => {
  const register = await request(app).post("/api/v1/auth/register").send({
    email,
    password: "verysecurepassword",
  });

  return {
    cookie: register.headers["set-cookie"][0] as string,
    workspaceId: register.body.workspaceId as string,
    userId: register.body.userId as string,
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

const normalizeTerms = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean)
    .map((term) => term.replace(/(ing|ed|es|s)$/i, ""))
    .filter((term) => term.length > 2)
    .filter((term) => !STOP_WORDS.has(term));

const normalizeRewriteContext = (text: string): string =>
  text
    .trim()
    .replace(/^tell me about\s+/i, "")
    .replace(/^what is\s+/i, "")
    .replace(/^what does\s+/i, "")
    .replace(/\s+explain\??$/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();

const hashTerm = (term: string): number => {
  let hash = 0;

  for (let index = 0; index < term.length; index += 1) {
    hash = (hash * 31 + term.charCodeAt(index)) >>> 0;
  }

  return hash;
};

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "are",
  "was",
  "were",
  "is",
  "it",
  "its",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "be",
  "or",
  "do",
  "doe",
]);
