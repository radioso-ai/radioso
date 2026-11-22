import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { ConversationAttributeReads } from "../../db/repositories/conversationAttributeReads.js";
import type { AuditEventInput } from "../../modules/audit/contracts/index.js";
import {
  ConversationAttributeEditService,
  ConversationAttributeService,
  type AttributeEditAudit,
  type ContextVariableRepositoryPort,
  type ConversationReclassification,
} from "../../modules/context-variables/public.js";
import { contextClassificationRequest } from "../../modules/contextClassification/public.js";
import type { BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/** An edit as an audit event: the ids, the action and the teammate, never the value. */
export const conversationAttributeEditAudit = (audit: { record(event: AuditEventInput): Promise<void> }): AttributeEditAudit => ({
  record: (entry) => audit.record({
    accountId: entry.actor.accountId,
    workspaceId: entry.workspaceId,
    eventType: `conversation_attribute.${entry.action}`,
    eventStatus: "success",
    metadata: {
      actorUserId: entry.actor.userId,
      surface: entry.actor.surface,
      conversationId: entry.conversationId,
      variableId: entry.variableId,
    },
  }),
});

/**
 * A teammate's sets and resets of a conversation's attributes, for the Inbox routes, Ray and operator
 * MCP. Composition binds the module's ports: the attribute reads over the agents module's revision
 * reader, the value repository that records `context_value.changed`, the classification job a reset
 * queues, and the audit log, which gets the ids and never the value.
 */
export const buildConversationAttributeEdits = (deps: {
  db: Db;
  values: Pick<ContextVariableRepositoryPort, "upsertValue" | "deleteValue">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  audit: { record(event: AuditEventInput): Promise<void> };
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}): ConversationAttributeEditService => {
  const reads = new ConversationAttributeReads(deps.db, new AgentRevisionRuntimeRepository(deps.db));
  // The run the classifier makes after a turn, keyed by conversation: a reset that lands while one
  // waits folds into it.
  const reclassification: ConversationReclassification = {
    request: async (input) => {
      await deps.queue.enqueue(contextClassificationRequest(input));
    },
  };
  return new ConversationAttributeEditService({
    reads,
    attributes: new ConversationAttributeService(reads),
    values: deps.values,
    reclassification,
    audit: conversationAttributeEditAudit(deps.audit),
    metrics: deps.metrics,
    logger: deps.logger,
  });
};
