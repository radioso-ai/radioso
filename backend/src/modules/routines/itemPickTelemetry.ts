import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { RoutineItemPickObserver } from "./domain.js";

interface ItemPickTelemetryContext {
  logger: Pick<AppLogger, "debug">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
  agentId: string;
  workspaceId?: string;
}

/**
 * Counts what each routine pick did (#1763), `applied` or `ignored`, and logs an ignored one at
 * debug level with its reason and ids only, never the item.
 */
export const itemPickTelemetry = (context: ItemPickTelemetryContext): RoutineItemPickObserver => (event) => {
  context.metricsRegistry?.incrementCounter("routine_item_pick_total", {
    help: "Cards visitors picked from routine steps, by whether the pick filled the step's slot",
    labels: { outcome: event.outcome },
  });
  if (event.outcome === "ignored") {
    context.logger.debug(
      {
        event: "routine.item_pick_ignored",
        reason: event.reason,
        routineId: event.routineId,
        stepId: event.stepId,
        agentId: context.agentId,
        workspaceId: context.workspaceId,
      },
      "A routine pick filled nothing",
    );
  }
};
