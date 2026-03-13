import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import {
  createAuditService,
  InMemoryAccountRepository,
  InMemoryAccountTokenRepository,
  InMemoryChunkRepository,
  InMemoryConversationRepository,
  InMemoryDocumentRepository,
  InMemoryMessageRepository,
  InMemoryRetrievalSettingsRepository,
  InMemorySessionRepository,
} from "./fakes.js";

export const createTestEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8080,
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5.2",
  OPENAI_VECTOR_MODEL: "text-embedding-3-large",
  SESSION_COOKIE_NAME: "hivec_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_HOURS: 168,
});

export const createTestDependencies = (): AppDependencies => {
  const env = createTestEnv();
  const auditService = createAuditService();
  const accountRepository = new InMemoryAccountRepository();
  const sessionRepository = new InMemorySessionRepository();
  const accountTokenRepository = new InMemoryAccountTokenRepository();
  const retrievalSettingsRepository = new InMemoryRetrievalSettingsRepository();
  const documentRepository = new InMemoryDocumentRepository();
  const chunkRepository = new InMemoryChunkRepository();
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
        if (!document || document.accountId !== input.accountId) {
          continue;
        }
        for (const chunk of chunks) {
          const score = keywordScore(chunk.content, currentQueryText);
          if (score >= input.similarityThreshold) {
            rows.push({
              chunkId: chunk.id,
              documentId,
              title: document.title,
              content: chunk.content,
              similarity: score,
            });
          }
        }
      }
      return rows.sort((a, b) => b.similarity - a.similarity).slice(0, input.topK);
    },
  };
  let currentQueryText = "";
  const embeddingService = new EmbeddingService({
    async embedTexts(texts: string[]): Promise<number[][]> {
      currentQueryText = texts[0] ?? "";
      return embeddingGateway.embedTexts(texts);
    },
  });
  const retrievalSettingsService = new RetrievalSettingsService(retrievalSettingsRepository, auditService);
  const retrievalPipeline = new RetrievalPipelineService(
    retrievalSettingsService,
    embeddingService,
    vectorSearch,
    new QueryRewriteService(),
    new RerankService(),
    new PromptBuilder(),
  );
  const chatGateway: ChatGateway = {
    async answer(input): Promise<string> {
      return `history:${input.history.length} ${input.prompt}`;
    },
  };

  return {
    env,
    logger: createLogger("silent"),
    auditService,
    authService: new AuthService({
      env,
      auditService,
      accountRepository,
      sessionRepository,
      accountTokenRepository,
    }),
    retrievalSettingsService,
    documentIngestionService: new DocumentIngestionService(
      documentRepository,
      chunkRepository,
      embeddingService,
      auditService,
    ),
    chatService: new ChatService(
      conversationRepository,
      messageRepository,
      retrievalPipeline,
      chatGateway,
      auditService,
    ),
  };
};

export const createTestApp = () => {
  const dependencies = createTestDependencies();
  return {
    app: createApp(dependencies),
    dependencies,
  };
};

const keywordScore = (content: string, query: string): number => {
  const lowerContent = content.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const term of terms) {
    if (lowerContent.includes(term)) {
      matches += 1;
    }
  }

  return matches / terms.length;
};
