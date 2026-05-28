import { describe, expect, it } from "vitest";

import { buildAgenticActivityTrace } from "../../src/modules/retrieval/services/agenticActivityTraceBuilder.js";
import type {
  AgentBudgets,
  AgentRunResult,
  AgentTraceEvent,
} from "../../src/shared/agent-runtime/index.js";

const defaultBudgets: AgentBudgets = {
  maxSteps: 6,
  maxToolResultTokens: 12_000,
  maxWallTimeMs: 30_000,
};

const baseRunResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
  terminatedReason: "completed",
  finalMessage: null,
  stepsTaken: 2,
  toolResultTokensUsed: 0,
  wallTimeMs: 100,
  ...overrides,
});

const validatedEvent = (stepIndex: number, callId: string, toolName: string): AgentTraceEvent => ({
  kind: "tool_call_validated",
  stepIndex,
  toolName,
  callId,
  input: {},
  at: 0,
});

const failedEvent = (stepIndex: number, callId: string, toolName: string, error = "boom"): AgentTraceEvent => ({
  kind: "tool_call_failed",
  stepIndex,
  toolName,
  callId,
  error,
  latencyMs: 10,
  at: 0,
});

const rejectedEvent = (stepIndex: number, callId: string, toolName: string): AgentTraceEvent => ({
  kind: "tool_call_rejected",
  stepIndex,
  toolName,
  callId,
  reason: "unknown_tool",
  details: "not a real tool",
  at: 0,
});

describe("buildAgenticActivityTrace — terminal stage attribution", () => {
  it("marks only the LAST invocation failure as 'failed' when the run terminated due to invocation", () => {
    const events: AgentTraceEvent[] = [
      validatedEvent(0, "c1", "flaky"),
      failedEvent(0, "c1", "flaky"),
      validatedEvent(1, "c2", "flaky"),
      failedEvent(1, "c2", "flaky"),
    ];
    const trace = buildAgenticActivityTrace({
      events,
      runResult: baseRunResult({ terminatedReason: "tool_invocation_failed", stepsTaken: 2 }),
      selectedChunkIds: [],
      finalRationale: null,
      traceStartedAtMs: 0,
      fallbackBudgets: defaultBudgets,
    });

    const failedStages = trace.stages.filter((s) => s.kind === "agent_tool_call");
    expect(failedStages).toHaveLength(2);
    expect(failedStages[0].status).toBe("fallback");
    expect(failedStages[1].status).toBe("failed");
    expect(failedStages[0].inputs?.callId).toBe("c1");
    expect(failedStages[1].inputs?.callId).toBe("c2");
  });

  it("marks only the LAST rejection as 'rejected' when the run terminated due to validation", () => {
    const events: AgentTraceEvent[] = [
      rejectedEvent(0, "c1", "ghost"),
      rejectedEvent(1, "c2", "ghost"),
    ];
    const trace = buildAgenticActivityTrace({
      events,
      runResult: baseRunResult({ terminatedReason: "tool_validation_failed", stepsTaken: 2 }),
      selectedChunkIds: [],
      finalRationale: null,
      traceStartedAtMs: 0,
      fallbackBudgets: defaultBudgets,
    });

    const stages = trace.stages.filter((s) => s.kind === "agent_tool_call");
    expect(stages).toHaveLength(2);
    expect(stages[0].status).toBe("fallback");
    expect(stages[1].status).toBe("rejected");
  });

  it("keeps every failure as fallback when the run did NOT terminate due to that failure mode", () => {
    // Run had one tool failure but ultimately completed (model recovered).
    const events: AgentTraceEvent[] = [
      validatedEvent(0, "c1", "flaky"),
      failedEvent(0, "c1", "flaky"),
      validatedEvent(1, "c2", "good"),
    ];
    const trace = buildAgenticActivityTrace({
      events,
      runResult: baseRunResult({ terminatedReason: "completed", stepsTaken: 2 }),
      selectedChunkIds: [],
      finalRationale: null,
      traceStartedAtMs: 0,
      fallbackBudgets: defaultBudgets,
    });

    const failedStages = trace.stages.filter((s) => s.inputs?.toolName === "flaky");
    expect(failedStages).toHaveLength(1);
    expect(failedStages[0].status).toBe("fallback");
  });
});
