import type { Kysely } from "kysely";

import { ContextVariableValueWrites } from "../../db/repositories/contextVariableValueWrites.js";
import { ContextValueSaves, type ContextValueSaver } from "../../modules/context-variables/public.js";
import type { WorkspaceEventDeliveryWake } from "../../shared/domain/workspaceEventSubscriptions.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { workspaceEventRecorder } from "./workspaceEventLog.js";

/**
 * The saves a chat turn makes of its ending routine's slot values (#1884), handed to the turn's
 * persistence: the value store in the turn's transaction, with the workspace event recorder, so a
 * conversation value's `context_value.changed` commits with the turn, and the write counter. The
 * turn's own post-commit wake delivers the events; the store never wakes delivery from a caller's
 * transaction.
 */
export const createRoutineValueSaves = (deps: {
  db: Kysely<DB>;
  delivery: WorkspaceEventDeliveryWake;
  metrics: MetricsRegistry | null;
}): ContextValueSaver => new ContextValueSaves({
  store: new ContextVariableValueWrites(deps.db, { recorder: workspaceEventRecorder, delivery: deps.delivery }),
  metrics: deps.metrics,
});
