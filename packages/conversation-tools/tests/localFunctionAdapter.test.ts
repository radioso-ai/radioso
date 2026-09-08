import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import {
  InMemoryConversationStores,
  noopSkillEmitPort,
  SkillExecutorRegistry,
} from "@radioso/conversation-defaults";

import {
  CONVERSATION_TOOLS_ADAPTER,
  createLocalFunctionToolService,
  createToolSkillDispatcher,
  createToolSkillExecutor,
  toolsToSkillDefinitions,
  type ToolSkillDefinition,
} from "../src/index.js";

describe("local function adapter", () => {
  it("registers and dispatches an in-process function", async () => {
    const service = createLocalFunctionToolService([{
      name: "math.add",
      description: "Adds two numbers",
      async execute(input) {
        const values = input as { left: number; right: number };
        return {
          status: "completed",
          outputs: { sum: values.left + values.right },
        };
      },
    }]);

    const result = await service.callTool({
      toolName: "math.add",
      input: { left: 2, right: 3 },
    });

    expect(result).toEqual({ status: "completed", outputs: { sum: 5 } });
  });

  it("runs a local function tool through DefaultConversationEngine and the defaults executor registry", async () => {
    const service = createLocalFunctionToolService([{
      name: "math.add",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { left: { type: "number" }, right: { type: "number" } },
        required: ["left", "right"],
      },
      async execute(input) {
        const values = input as { left: number; right: number };
        return {
          status: "completed",
          answer: `sum:${values.left + values.right}`,
          outputs: { sum: values.left + values.right },
        };
      },
    }]);
    const skills = toolsToSkillDefinitions(await service.listTools());
    const executor = createToolSkillExecutor(service);
    const registry = new SkillExecutorRegistry([{
      kind: "internal",
      adapter: CONVERSATION_TOOLS_ADAPTER,
      executor,
    }]);
    const dispatcher = {
      async dispatch({ skill, selected, turn }: Parameters<ReturnType<typeof createToolSkillDispatcher>["dispatch"]>[0]) {
        const execution = (skill as ToolSkillDefinition).execution;
        const resolved = registry.resolve(execution);
        if (!resolved) {
          throw new Error("missing executor");
        }
        const result = await resolved.dispatch({
          skill,
          collected: selected.input as Record<string, unknown>,
          context: selected.metadata,
          emit: noopSkillEmitPort,
        });
        if (result.disposition !== "settled") {
          throw new Error("unexpected deferred result");
        }
        return {
          kind: "tool",
          skillName: skill.name,
          outcome: result.outcome,
          stagedContext: [],
          steering: turn.steering,
          trace: {
            traceId: "local-tool",
            startedAt: new Date(0).toISOString(),
            stages: [],
          },
        };
      },
    };

    const engine = new DefaultConversationEngine();
    const stores = new InMemoryConversationStores();
    const result = await engine.processTurn({
      agent: { id: "agent_1" },
      sessionId: "session_1",
      inputEvent: { kind: "message", content: "add" },
      skills,
      directives: [],
      stores,
      modelGateway: { complete: vi.fn() },
      directiveMatcher: { match: vi.fn(async () => []) },
      selector: {
        select: vi.fn(async () => ({
          selected: [{ skillName: "math.add", input: { left: 4, right: 6 } }],
        })),
      },
      dispatcher,
      composer: {
        compose: vi.fn(async ({ outcomes }) => ({
          answer: outcomes[0]?.outcome.answer ?? "",
        })),
      },
    });

    expect(result.response.answer).toBe("sum:10");
    expect(result.outcomes[0]?.outcome.outputs).toEqual({ sum: 10 });
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });
});
