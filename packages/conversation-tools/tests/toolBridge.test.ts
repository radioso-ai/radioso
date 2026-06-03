import { describe, expect, it } from "vitest";

import type { ToolCallInput, ToolService } from "../src/index.js";
import {
  createToolSkillDispatcher,
  toolToSkillDefinition,
  ToolSkillBridge,
} from "../src/index.js";

const turn = {
  agent: { id: "agent_1" },
  sessionId: "session_1",
  inputEvent: { kind: "message", content: "hello" },
  history: [],
  stagedContext: [],
  steering: [],
};

describe("tool skill bridge", () => {
  it("lists tools as skill definitions with executor metadata", async () => {
    const service: ToolService = {
      async listTools() {
        return [{ name: "lookup", description: "Looks up a record", inputSchema: { type: "object" } }];
      },
      async callTool() {
        return { status: "completed" };
      },
    };

    const skills = await new ToolSkillBridge(service, { source: "test" }).listSkillDefinitions();

    expect(skills).toEqual([expect.objectContaining({
      name: "lookup",
      description: "Looks up a record",
      execution: { kind: "internal", adapter: "conversation-tools" },
      metadata: {
        conversationTool: { toolName: "lookup", source: "test" },
      },
    })]);
  });

  it("dispatches a fake tool into a valid TurnOutcome", async () => {
    const calls: ToolCallInput[] = [];
    const service: ToolService = {
      async listTools() {
        return [];
      },
      async callTool(input) {
        calls.push(input);
        return {
          status: "completed",
          answer: "done",
          outputs: { id: "record_1" },
          stagedContext: [{ kind: "lookup.result", data: { id: "record_1" } }],
          guidance: [{ action: "Use the lookup result." }],
        };
      },
    };
    const skill = toolToSkillDefinition({ name: "lookup" });
    const dispatcher = createToolSkillDispatcher(service);

    const outcome = await dispatcher.dispatch({
      skill,
      turn,
      selected: { skillName: "lookup", input: { id: "record_1" } },
    });

    expect(calls).toEqual([expect.objectContaining({
      toolName: "lookup",
      input: { id: "record_1" },
    })]);
    expect(outcome).toMatchObject({
      kind: "tool",
      skillName: "lookup",
      outcome: {
        status: "completed",
        answer: "done",
        outputs: { id: "record_1" },
        guidance: [{ action: "Use the lookup result." }],
      },
      stagedContext: [{ kind: "lookup.result", data: { id: "record_1" } }],
    });
    expect(outcome.trace.stages[0]).toMatchObject({
      kind: "tool_call",
      status: "applied",
      outputs: { skillName: "lookup", toolName: "lookup", outcomeStatus: "completed" },
    });
  });

  it("converts thrown tool errors into failed outcomes", async () => {
    const dispatcher = createToolSkillDispatcher({
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("unavailable");
      },
    });

    const outcome = await dispatcher.dispatch({
      skill: { name: "broken" },
      turn,
      selected: { skillName: "broken" },
    });

    expect(outcome.outcome).toMatchObject({
      status: "failed",
      error: { code: "tool_call_failed", message: "unavailable" },
    });
  });

  it("keeps non-terminal outcomes applied and emits unique trace IDs", async () => {
    const dispatcher = createToolSkillDispatcher({
      async listTools() {
        return [];
      },
      async callTool() {
        return { status: "awaiting_tool" };
      },
    });
    const skill = toolToSkillDefinition({ name: "lookup" });

    const first = await dispatcher.dispatch({
      skill,
      turn,
      selected: { skillName: "lookup" },
    });
    const second = await dispatcher.dispatch({
      skill,
      turn,
      selected: { skillName: "lookup" },
    });

    expect(first.trace.stages[0]?.status).toBe("applied");
    expect(second.trace.stages[0]?.status).toBe("applied");
    expect(first.trace.traceId).not.toBe(second.trace.traceId);
  });
});
