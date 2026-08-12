import type { AgentTraceEvent, TerminatedReason } from "../../shared/agent-runtime/index.js";
import type { CopilotEntityReference, CopilotSseEvent, CopilotTurnOutcome } from "./contracts.js";

const budgetTerminationReasons = new Set<TerminatedReason>([
  "step_budget_exhausted",
  "token_budget_exhausted",
  "wall_time_exhausted",
]);

export const outcomeFromTerminatedReason = (reason: TerminatedReason): CopilotTurnOutcome => {
  if (reason === "completed") {
    return "completed";
  }
  return budgetTerminationReasons.has(reason) ? "budget_exhausted" : "failed";
};

export const mapCopilotTraceEvent = (
  trace: AgentTraceEvent,
  labels: ReadonlyMap<string, string>,
  entitiesByToolCall: ReadonlyMap<string, CopilotEntityReference> = new Map(),
): CopilotSseEvent | null => {
  switch (trace.kind) {
    case "model_message":
      return { event: "chunk", data: { text: trace.content } };
    case "tool_call_invoked":
      return activity(trace.callId, trace.toolName, "started", labels, entitiesByToolCall.get(trace.callId));
    case "tool_call_completed":
      return activity(trace.callId, trace.toolName, "completed", labels, entitiesByToolCall.get(trace.callId));
    case "tool_call_failed":
    case "tool_call_rejected":
      return activity(trace.callId, trace.toolName, "failed", labels, entitiesByToolCall.get(trace.callId));
    default:
      return null;
  }
};

const activity = (
  toolCallId: string,
  toolName: string,
  stage: "started" | "completed" | "failed",
  labels: ReadonlyMap<string, string>,
  entity?: CopilotEntityReference,
): CopilotSseEvent => ({
  event: "activity",
  data: { toolCallId, tool: labels.get(toolName) ?? "Operator capability", stage, ...(entity ? { entity } : {}) },
});
