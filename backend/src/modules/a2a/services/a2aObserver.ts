import { createHash } from "node:crypto";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { A2A_SERVED_METHODS } from "../domain/jsonRpc.js";
import type { A2aTaskState } from "../domain/taskState.js";

const REQUESTS_TOTAL = "a2a_requests_total";
const TASK_TRANSITIONS_TOTAL = "a2a_task_transitions_total";

/**
 * A request's method as a metric label: a served method, or `other` for whatever else a client
 * named, so an arbitrary string never becomes a series.
 */
const methodLabel = (method: string | null): string =>
  method !== null && (A2A_SERVED_METHODS as readonly string[]).includes(method) ? method : "other";

/** A context, task or conversation id as a log may carry it: a short digest, never the id itself. */
const logDigest = (value: string): string => createHash("sha256").update(value).digest("base64url").slice(0, 16);

export interface A2aObserver {
  /** One answered request: `ok`, an A2A error reason, a Radioso reason, or an HTTP refusal. */
  request(input: { method: string | null; outcome: string }): void;
  transition(toState: A2aTaskState): void;
  /** A caller refused admission, named by the source digest and agent as walk-in MCP refusals are. */
  refused(input: { method: string; code: string; agentId: string; sourceDigest: string | null; taskId?: string }): void;
  /**
   * A failed send could not release its claim. The claim stays in flight, so a retry of the message
   * answers `TURN_IN_PROGRESS` until the claim goes stale and the retry takes it over.
   */
  receiptReleaseFailed(input: { conversationId: string; error: unknown }): void;
}

export const createA2aObserver = (dependencies: {
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "info" | "warn">;
}): A2aObserver => ({
  request({ method, outcome }) {
    dependencies.metrics?.incrementCounter(REQUESTS_TOTAL, {
      help: "A2A JSON-RPC requests by method and outcome.",
      labels: { method: methodLabel(method), outcome },
    });
  },
  transition(toState) {
    dependencies.metrics?.incrementCounter(TASK_TRANSITIONS_TOTAL, {
      help: "A2A task state transitions by the state entered.",
      labels: { to_state: toState },
    });
  },
  refused({ method, code, agentId, sourceDigest, taskId }) {
    dependencies.logger?.info(
      { method, refusal: code, agentId, sourceDigest, ...(taskId ? { taskDigest: logDigest(taskId) } : {}) },
      "A2A request refused",
    );
  },
  receiptReleaseFailed({ conversationId, error }) {
    // The logger's error serializer keeps the error's class and code, never its message.
    dependencies.logger?.warn({ conversationDigest: logDigest(conversationId), err: error }, "A2A message receipt release failed");
  },
});
