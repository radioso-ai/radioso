import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { ClassifiedContextVariableReads } from "../../db/repositories/classifiedContextVariableReads.js";
import type { ContextVariableRepository } from "../../db/repositories/contextVariableRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import { ConversationSummaryRepository } from "../../db/repositories/conversationSummaryRepository.js";
import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import { ContextClassificationExcerptReader } from "../../modules/chat/composition.js";
import { ConversationValueWriterService } from "../../modules/context-variables/public.js";
import {
  ConversationClassificationService,
  contextClassificationHandler,
} from "../../modules/contextClassification/public.js";
import type { BackgroundJobHandlerRegistration } from "../../shared/background-jobs/index.js";
import type { UsageEventRecorder } from "../../shared/domain/usageEventRecorder.js";
import type { LlmCapabilityResolver } from "../../shared/infra/llm/capabilityResolver.js";
import { createRewriteTierStructuredInferenceFactory } from "../../shared/infra/llm/contextualGateways.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * The classifier of agents' classified attributes: the context-variable reads (over the agents
 * module's revision reader) and writer, chat's view of a conversation, and the workspace's
 * `rewrite` model with every call metered. The job's
 * handler runs it after a turn commits; Test Chat runs it through `classifyTranscript`.
 */
export const buildContextClassification = (deps: {
  infrastructure: {
    database: { kysely: Db };
    usageEventRecorder: UsageEventRecorder;
    metricsRegistry: MetricsRegistry | null;
  };
  repositories: {
    conversationRepository: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    messageRepository: Pick<MessageRepositoryPort, "listRecentByConversationId">;
  };
  contextVariableRepository: ContextVariableRepository;
  resolver: LlmCapabilityResolver;
  logger: AppLogger;
}): { classifier: ConversationClassificationService; jobHandler: BackgroundJobHandlerRegistration } => {
  const db = deps.infrastructure.database.kysely;
  const classifier = new ConversationClassificationService({
    // The pinned revision's enablements come through the agents module's revision reader, which owns the snapshot.
    targets: new ClassifiedContextVariableReads(db, new AgentRevisionRuntimeRepository(db)),
    excerpts: new ContextClassificationExcerptReader({
      conversations: deps.repositories.conversationRepository,
      messages: deps.repositories.messageRepository,
      summaries: new ConversationSummaryRepository(db),
      logger: deps.logger,
    }),
    values: new ConversationValueWriterService({ repository: deps.contextVariableRepository, metrics: deps.infrastructure.metricsRegistry }),
    inference: createRewriteTierStructuredInferenceFactory({ resolver: deps.resolver }, deps.infrastructure.usageEventRecorder),
    metrics: deps.infrastructure.metricsRegistry,
    logger: deps.logger,
  });
  return { classifier, jobHandler: contextClassificationHandler(classifier) };
};
