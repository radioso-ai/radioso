import { describe, expect, it } from "vitest";

import {
  mapCopilotTraceEvent,
  outcomeFromTerminatedReason,
} from "../../../src/modules/operatorCopilot/public.js";

describe("operator copilot SSE trace mapping", () => {
  it("maps only safe trace data and never exposes tool inputs or outputs", () => {
    const event = mapCopilotTraceEvent(
      {
        kind: "tool_call_completed",
        stepIndex: 1,
        toolName: "conversation_transcript",
        callId: "call-1",
        output: { transcript: "private customer content" },
        resultTokens: 22,
        latencyMs: 8,
        at: 1,
      },
      new Map([["conversation_transcript", "Reading conversation transcript"]]),
    );

    expect(event).toEqual({
      event: "activity",
      data: { toolCallId: "call-1", tool: "Reading conversation transcript", stage: "completed" },
    });
    expect(JSON.stringify(event)).not.toContain("private customer content");
  });

  it("maps model text to chunks and budget terminations to the fixed outcome", () => {
    expect(mapCopilotTraceEvent(
      { kind: "model_message", stepIndex: 0, content: "Grounded answer", at: 1 },
      new Map(),
    )).toEqual({ event: "chunk", data: { text: "Grounded answer" } });
    expect(outcomeFromTerminatedReason("wall_time_exhausted")).toBe("budget_exhausted");
    expect(outcomeFromTerminatedReason("completed")).toBe("completed");
  });
});
