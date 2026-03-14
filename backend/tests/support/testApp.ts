import { setTimeout as delay } from "node:timers/promises";

import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
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
  OPENAI_CHAT_MODEL: "gpt-5-mini",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  SESSION_COOKIE_NAME: "hivec_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_HOURS: 168,
});

export const createTestDependencies = (overrides: {
  chatGateway?: ChatGateway;
} = {}): AppDependencies => {
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
  let currentQueryText = "";
  const embeddingService = new EmbeddingService({
    async embedTexts(texts: string[]): Promise<number[][]> {
      currentQueryText = texts[0] ?? "";
      return embeddingGateway.embedTexts(texts);
    },
  });
  const queryRewriteGateway: QueryRewriteGateway = {
    async rewrite(input) {
      const lastUserContext =
        [...input.contextMessages].reverse().find((message) => message.role === "user")?.content ?? "";
      const normalizedContext = lastUserContext
        .replace(/^tell me about\s+/i, "")
        .replace(/^what is\s+/i, "")
        .trim();

      if (/used for/i.test(input.query) && normalizedContext.length > 0) {
        return {
          rewrittenQuery: `${normalizedContext} used for`.trim(),
          confidence: 0.95,
        };
      }

      return {
        rewrittenQuery: `${lastUserContext} ${input.query}`.trim(),
        confidence: 0.9,
      };
    },
  };
  const rerankGateway: RerankGateway = {
    async rerank(input) {
      return input.contexts.map((context) => ({
        chunkId: context.chunkId,
        relevanceScore: keywordScore(`${context.title} ${context.content}`, input.query),
      }));
    },
  };
  const retrievalSettingsService = new RetrievalSettingsService(retrievalSettingsRepository, auditService);
  const retrievalPipeline = new RetrievalPipelineService(
    retrievalSettingsService,
    embeddingService,
    vectorSearch,
    new ConversationContextService(),
    new QueryRewriteService(queryRewriteGateway),
    new CandidatePreparationService(),
    new RerankService(rerankGateway),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
  );
  const defaultChatGateway: ChatGateway = {
    async answer(input): Promise<string> {
      const warmthMatch = input.prompt.match(/Warmth:(\d+)/);
      const warmthLevel = warmthMatch ? Number(warmthMatch[1]) : 5;
      const firstContext = input.prompt
        .match(/Context 1 \([^)]+\): ([\s\S]*?)(?:\n\n|$)/)?.[1]
        ?.trim();

      return `Warmth:${warmthLevel} ${firstContext || `history:${input.history.length} ${input.query}`}`.trim();
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
    ),
  };
};

export const createTestApp = (overrides: {
  chatGateway?: ChatGateway;
} = {}) => {
  const dependencies = createTestDependencies(overrides);
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
  const normalizedTerms = terms
    .map((term) => term.replace(/(ing|ed|es|s)$/i, ""))
    .filter((term) => term.length > 2)
    .filter((term) => !STOP_WORDS.has(term));

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
