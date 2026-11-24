import type { Kysely } from "kysely";

import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { ContextVariableValueWrites } from "../../db/repositories/contextVariableValueWrites.js";
import { readConversationSaveContext } from "../../db/repositories/conversationClassifiedVariables.js";
import { ContextValueSaves, type ContextValueSaver } from "../../modules/context-variables/public.js";
import type { WorkspaceEventDeliveryWake } from "../../shared/domain/workspaceEventSubscriptions.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { workspaceEventRecorder } from "./workspaceEventLog.js";

/**
 * The saves a chat turn makes of its ending routine's slot values (#1884), handed to the turn's
 * persistence: the value store in the turn's transaction, with the workspace event recorder, so a
 * conversation value's `context_value.changed` commits with the turn; the conversation's save
 * context, read in that transaction (the customer its row is bound to, and the attributes the
 * release it is pinned to keeps); and the write counter. The turn's own post-commit wake delivers
 * the events; the store never wakes delivery from a caller's transaction.
 */
export const createRoutineValueSaves = (deps: {
  db: Kysely<DB>;
  delivery: WorkspaceEventDeliveryWake;
  metrics: MetricsRegistry | null;
}): ContextValueSaver => {
  const revisions = new AgentRevisionRuntimeRepository(deps.db);
  return new ContextValueSaves({
    store: new ContextVariableValueWrites(deps.db, { recorder: workspaceEventRecorder, delivery: deps.delivery }),
    conversations: { read: (trx, input) => readConversationSaveContext(trx, revisions, input) },
    metrics: deps.metrics,
  });
};
