import { metricModelLabel } from "../../shared/infra/llm/knownModels.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { RoutineSelectorCompletionObserver } from "./domain.js";

interface SelectorCompletionTelemetryContext {
  logger: Pick<AppLogger, "warn">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
  agentId: string;
  workspaceId?: string;
}

/**
 * Observes every completion the routine next-step selector reads (#1715). Each is counted by
 * model, step kind, call and result, so the share of a model's completions that come back
 * unreadable is visible beside the ones it reads, not only in turn traces. An unreadable one is
 * also logged with the ids that tie it to its conversation, its stop reason and its sizes.
 * Neither carries the prompt, the completion, or anything from the visitor's message.
 */
export const selectorCompletionTelemetry = (
  context: SelectorCompletionTelemetryContext,
): RoutineSelectorCompletionObserver => (event) => {
  context.metricsRegistry?.incrementCounter("routine_next_step_completions_total", {
    help: "Routine next-step selector completions by model, step kind, call, and whether they could be read.",
    labels: {
      model: metricModelLabel(event.model),
      step_kind: event.stepKind,
      call: event.call,
      result: event.unreadableReason ?? "read",
    },
  });
  if (!event.unreadableReason) {
    return;
  }
  context.logger.warn(
    {
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      routineId: event.routineId,
      stepId: event.stepId,
      stepKind: event.stepKind,
      sessionId: event.sessionId,
      call: event.call,
      reason: event.unreadableReason,
      model: event.model,
      stopReason: event.stopReason,
      outputChars: event.outputChars,
      promptChars: event.promptChars,
    },
    "Routine next-step decision was unreadable",
  );
};
