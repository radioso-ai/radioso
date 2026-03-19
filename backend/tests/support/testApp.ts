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
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
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
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { UsageCaptureService } from "../../src/modules/usage/services/usageCaptureService.js";
import { UsageSummaryService } from "../../src/modules/usage/services/usageSummaryService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { ConnectorRegistry } from "../../src/modules/connectors/services/connectorRegistry.js";
import { createConnectorChatPort } from "../../src/modules/connectors/services/connectorChatPort.js";
import { WhatsAppPlugin } from "../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryAccountRepository,
  InMemoryWorkspaceTokenRepository,
  InMemoryChunkRepository,
  InMemoryConversationRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryMessageRepository,
  InMemoryRetrievalSettingsRepository,
  InMemorySessionRepository,
  InMemoryWorkspaceRepository,
  InMemoryConnectorDatabase,
  InMemoryUsageEventRepository,
  InMemoryAccountDailyUsageSummaryRepository,
} from "./fakes.js";

export const createTestEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8080,
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5-mini",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  SESSION_COOKIE_NAME: "hivec_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_HOURS: 168,
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
});

const estimateTokenCount = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
};

interface TestRepositories {
  retrievalSettingsRepository: InMemoryRetrievalSettingsRepository;
  documentRepository: InMemoryDocumentRepository;
  chunkRepository: InMemoryChunkRepository;
  documentProcessingJobRepository: InMemoryDocumentProcessingJobRepository;
}

export const createTestDependencies = (overrides: {
  chatGateway?: ChatGateway;
  chunkingSimilarityPort?: ChunkingSimilarityPort;
  lexicalSearch?: LexicalSearchPort;
  queryRewriteGateway?: QueryRewriteGateway;
  rerankGateway?: RerankGateway;
  whatsappFetch?: typeof fetch;
  whatsappDebounceMs?: number;
} = {}): { dependencies: AppDependencies; repositories: TestRepositories } => {
  const env = createTestEnv();
  const auditEventRepository = new InMemoryAuditEventRepository();
  const auditService = createAuditService(auditEventRepository);
  const accountRepository = new InMemoryAccountRepository();
  const sessionRepository = new InMemorySessionRepository();
  const workspaceTokenRepository = new InMemoryWorkspaceTokenRepository();
  const retrievalSettingsRepository = new InMemoryRetrievalSettingsRepository();
  const accountDailyUsageSummaryRepository = new InMemoryAccountDailyUsageSummaryRepository();
  const usageEventRepository = new InMemoryUsageEventRepository(accountDailyUsageSummaryRepository);
  const usageCaptureService = new UsageCaptureService(usageEventRepository);
  const usageSummaryService = new UsageSummaryService(
    usageEventRepository,
    accountDailyUsageSummaryRepository,
  );
  const workspaceRepository = new InMemoryWorkspaceRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const documentProcessingJobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(documentProcessingJobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const embeddingGateway: EmbeddingGateway = {
    async embedTexts(texts: string[]): Promise<number[][]> {
      const promptTokens = texts.reduce((sum, text) => sum + estimateTokenCount(text), 0);
      await usageCaptureService.observe({
        operationKey: randomUUID(),
        sourceArea: "retrieval",
        operationType: "embedding",
        model: env.OPENAI_VECTOR_MODEL,
        eventStatus: "success",
        usageAvailable: true,
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        metadata: { inputCount: texts.length },
      });

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
      const promptTokens =
        estimateTokenCount(input.query) +
        input.contextMessages.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
      const recordRewriteUsage = async (rewrittenQuery: string) => {
        const completionTokens = estimateTokenCount(rewrittenQuery);
        await usageCaptureService.observe({
          operationKey: randomUUID(),
          sourceArea: "retrieval",
          operationType: "query_rewrite",
          model: env.OPENAI_CHAT_MODEL,
          eventStatus: "success",
          usageAvailable: true,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          metadata: { query: input.query },
        });
      };
      const lastUserContext =
        [...input.contextMessages].reverse().find((message) => message.role === "user")?.content ?? "";
      const normalizedContext = normalizeRewriteContext(lastUserContext);

      if (/used for/i.test(input.query) && normalizedContext.length > 0) {
        const result = {
          rewrittenQuery: `${normalizedContext} used for`.trim(),
          turnKind: "referential_followup",
          proposedActiveSubject: normalizedContext,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.95,
        };
        await recordRewriteUsage(result.rewrittenQuery);
        return result;
      }

      if (/who is it for/i.test(input.query) && normalizedContext.length > 0) {
        const result = {
          rewrittenQuery: `${normalizedContext} audience`.trim(),
          turnKind: "referential_followup",
          proposedActiveSubject: normalizedContext,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        };
        await recordRewriteUsage(result.rewrittenQuery);
        return result;
      }

      if (/work with/i.test(input.query) && normalizedContext.length > 0) {
        const result = {
          rewrittenQuery: input.query.trim(),
          turnKind: "referential_relation",
          proposedActiveSubject: normalizedContext,
          relatedEntities: ["Arudra"],
          unresolved: true,
          confidence: 0.75,
        };
        await recordRewriteUsage(result.rewrittenQuery);
        return result;
      }

      const result = {
        rewrittenQuery: `${lastUserContext} ${input.query}`.trim(),
        turnKind: "referential_followup",
        proposedActiveSubject: normalizedContext || undefined,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      };
      await recordRewriteUsage(result.rewrittenQuery);
      return result;
    },
  };
  const queryRewriteGateway = overrides.queryRewriteGateway ?? defaultQueryRewriteGateway;
  const defaultRerankGateway: RerankGateway = {
    async rerank(input) {
      const promptTokens =
        estimateTokenCount(input.query) +
        input.contexts.reduce((sum, context) => sum + estimateTokenCount(context.content), 0);
      await usageCaptureService.observe({
        operationKey: randomUUID(),
        sourceArea: "retrieval",
        operationType: "semantic_rerank",
        model: env.OPENAI_CHAT_MODEL,
        eventStatus: "success",
        usageAvailable: true,
        promptTokens,
        completionTokens: input.contexts.length,
        totalTokens: promptTokens + input.contexts.length,
        metadata: { candidateCount: input.contexts.length, query: input.query },
      });

      return input.contexts.map((context) => ({
        chunkId: context.chunkId,
        relevanceScore: keywordScore(`${context.title} ${context.content}`, input.query),
      }));
    },
  };
  const rerankGateway = overrides.rerankGateway ?? defaultRerankGateway;
  const retrievalSettingsService = new RetrievalSettingsService(retrievalSettingsRepository, auditService);
  const documentProcessingService = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    embeddingService,
    auditService,
    retrievalSettingsService,
    chunkingStrategyRegistry,
    workspaceRepository,
    usageCaptureService,
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
  const buildChatAnswer = (input: { query: string; history: Array<{ content: string }>; prompt: string }) => {
    const warmthMatch = input.prompt.match(/Warmth:(\d+)/);
    const warmthLevel = warmthMatch ? Number(warmthMatch[1]) : 5;
    const firstContext = input.prompt
      .match(/Result 1 \([^)]+\): ([\s\S]*?)(?:\n\n|$)/)?.[1]
      ?.trim();

    if (firstContext) {
      return `Warmth:${warmthLevel} ${firstContext}[[1]]`.trim();
    }

    return `Warmth:${warmthLevel} history:${input.history.length} ${input.query}`.trim();
  };
  const defaultChatGateway: ChatGateway = {
    async answer(input): Promise<string> {
      const content = buildChatAnswer(input);
      const promptTokens = estimateTokenCount(input.prompt);
      const completionTokens = estimateTokenCount(content);
      await usageCaptureService.observe({
        operationKey: randomUUID(),
        sourceArea: "chat",
        operationType: "chat_answer",
        model: env.OPENAI_CHAT_MODEL,
        eventStatus: "success",
        usageAvailable: true,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        metadata: { query: input.query },
      });
      return content;
    },
    async *streamAnswer(input) {
      const content = buildChatAnswer(input);
      const promptTokens = estimateTokenCount(input.prompt);
      const completionTokens = estimateTokenCount(content);
      await usageCaptureService.observe({
        operationKey: randomUUID(),
        sourceArea: "chat",
        operationType: "chat_answer",
        model: env.OPENAI_CHAT_MODEL,
        eventStatus: "success",
        usageAvailable: true,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        metadata: { query: input.query, stream: true },
      });
      const midpoint = Math.max(1, Math.ceil(content.length / 2));
      yield content.slice(0, midpoint);
      await delay(5);
      yield content.slice(midpoint);
    },
  };
  const chatGateway = overrides.chatGateway ?? defaultChatGateway;

  const workspaceService = new WorkspaceService(workspaceRepository, auditService);
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
      authService: new AuthService({
        env,
        auditService,
        accountRepository,
        sessionRepository,
        workspaceTokenRepository,
        workspaceService,
      }),
      workspaceService,
      usageCaptureService,
      usageSummaryService,
      retrievalSettingsService,
      documentIngestionService,
      documentProcessingWorker,
      documentDeletionService: new DocumentDeletionService(
        documentRepository,
        auditService,
      ),
      chatService: new ChatService(
        conversationRepository,
        messageRepository,
        retrievalPipeline,
        chatGateway,
        auditService,
        workspaceRepository,
        usageCaptureService,
      ),
      chatHistoryService: new ChatHistoryService(
        conversationRepository,
        messageRepository,
        auditEventRepository,
        usageSummaryService,
      ),
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
  whatsappFetch?: typeof fetch;
  whatsappDebounceMs?: number;
} = {}) => {
  const { dependencies, repositories } = createTestDependencies(overrides);
  return {
    app: createApp(dependencies),
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

  const tokenResponse = await request(app)
    .get(`/api/v1/account/workspaces/${workspaceId}/token`)
    .set("Cookie", cookie);

  return { token: tokenResponse.body.token, cookie, workspaceId };
};

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
