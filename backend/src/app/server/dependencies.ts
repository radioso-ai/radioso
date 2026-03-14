import { getEnv, type Env } from "../config/env.js";
import { ChatService, OpenAIChatGateway } from "../../modules/chat/services/chatService.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { AccountTokenRepository } from "../../db/repositories/accountTokenRepository.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { ChunkRepository } from "../../db/repositories/chunkRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../db/repositories/documentRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { RetrievalSettingsRepository } from "../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../db/repositories/sessionRepository.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { AuditService } from "../../modules/audit/services/auditService.js";
import { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import { PgVectorSearch } from "../../modules/retrieval/infra/vectorSearch.js";
import { CandidatePreparationService } from "../../modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../modules/retrieval/services/promptContextSelectorService.js";
import { ChunkingStrategyRegistry } from "../../modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { StructuredSemanticChunkingStrategy } from "../../modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";
import { OpenAIQueryRewriteGateway, QueryRewriteService } from "../../modules/retrieval/services/queryRewriteService.js";
import { OpenAISemanticRerankGateway, RerankService } from "../../modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../modules/retrieval/services/retrievalPipelineService.js";
import { RetrievalExecutionTelemetryService } from "../../modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { OpenAIEmbeddingGateway, EmbeddingService } from "../../modules/retrieval/services/embeddingService.js";
import { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import { Database } from "../../shared/infra/database.js";
import { OpenAIClients } from "../../shared/infra/openaiClient.js";
import { createLogger } from "../../shared/observability/logger.js";
import type { AppDependencies } from "./types.js";

export const buildDependencies = (env: Env = getEnv()): AppDependencies => {
  const logger = createLogger();
  const database = new Database(env.DATABASE_URL);
  const auditService = new AuditService(logger, new AuditEventRepository(database));
  const openai = new OpenAIClients(env.OPENAI_API_KEY, env.OPENAI_CHAT_MODEL, env.OPENAI_VECTOR_MODEL);
  const retrievalSettingsService = new RetrievalSettingsService(new RetrievalSettingsRepository(database), auditService);
  const embeddingService = new EmbeddingService(new OpenAIEmbeddingGateway(openai.client, openai.vectorModel));
  const chunkingStrategyRegistry = new ChunkingStrategyRegistry([
    new FixedWindowChunkingStrategy(),
    new StructuredSemanticChunkingStrategy(embeddingService),
  ]);
  const documentIngestionService = new DocumentIngestionService(
    new DocumentRepository(database),
    new ChunkRepository(database),
    embeddingService,
    auditService,
    retrievalSettingsService,
    chunkingStrategyRegistry,
  );
  const retrievalPipeline = new RetrievalPipelineService(
    retrievalSettingsService,
    embeddingService,
    new PgVectorSearch(database),
    new ConversationContextService(),
    new QueryRewriteService(new OpenAIQueryRewriteGateway(openai.client, openai.chatModel)),
    new CandidatePreparationService(),
    new RerankService(new OpenAISemanticRerankGateway(openai.client, openai.chatModel)),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
  );
  const chatService = new ChatService(
    new ConversationRepository(database),
    new MessageRepository(database),
    retrievalPipeline,
    new OpenAIChatGateway(openai.client, openai.chatModel),
    auditService,
  );
  const authService = new AuthService({
    env,
    accountRepository: new AccountRepository(database),
    sessionRepository: new SessionRepository(database),
    accountTokenRepository: new AccountTokenRepository(database),
    auditService,
  });

  return {
    env,
    logger,
    authService,
    auditService,
    retrievalSettingsService,
    documentIngestionService,
    chatService,
  };
};
