import { describe, expect, it, vi } from "vitest";

import type {
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
  TurnOutcome,
} from "@radioso/conversation-contract";
import {
  AlwaysMatchDirectiveMatcher,
  InMemoryConversationStores,
  SkillExecutorRegistry,
  type SkillDispatchResult,
} from "@radioso/conversation-defaults";
import { DefaultConversationEngine } from "@radioso/conversation-engine";

import { OpenAIConversationModelGateway, type OpenAIChatClient } from "../src/index.js";

const createMockProvider = (): OpenAIChatClient => ({
  chat: {
    completions: {
      create: vi.fn<OpenAIChatClient["chat"]["completions"]["create"]>(async () => ({
        id: "chatcmpl_e2e",
        model: "gpt-e2e",
        choices: [{ message: { content: "The kit completed the turn." } }],
        usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
      })),
    },
  },
});

const createRegistryDispatcher = (registry: SkillExecutorRegistry): ConversationSkillDispatcher => ({
  async dispatch({ skill, turn, selected }): Promise<TurnOutcome> {
    const execution = { kind: "internal" as const, adapter: skill.name };
    const executor = registry.resolve(execution);
    if (!executor) {
      throw new Error(`missing executor for ${skill.name}`);
    }
    const result: SkillDispatchResult = await executor.dispatch({
      skill,
      collected: selected.input && typeof selected.input === "object" && !Array.isArray(selected.input)
        ? selected.input
        : {},
      context: { sessionId: turn.sessionId },
      emit: {
        async emitStatus() {},
        async emitCustom() {},
      },
    });
    if (result.disposition !== "settled") {
      throw new Error("deferred skill results are outside this test");
    }
    return {
      kind: "generic",
      skillName: skill.name,
      outcome: result.outcome,
      stagedContext: [{ kind: "skill", data: result.outcome.outputs ?? {} }],
      steering: turn.steering,
      trace: {
        traceId: "registry-dispatch",
        startedAt: new Date(0).toISOString(),
        stages: [],
      },
    };
  },
});

describe("conversation-nlp kit wiring", () => {
  it("runs a full engine turn with defaults, this gateway, and a mocked provider", async () => {
    const provider = createMockProvider();
    const gateway = new OpenAIConversationModelGateway({
      client: provider,
      model: "gpt-e2e",
      reasoningEffort: "medium",
    });
    const stores = new InMemoryConversationStores();
    const selector: ConversationSkillSelector = {
      async select() {
        return {
          selected: [{ skillName: "lookup", input: { query: "status" }, reason: "test default selection" }],
          reason: "selected registered lookup skill",
        };
      },
    };
    const registry = new SkillExecutorRegistry([
      {
        kind: "internal",
        adapter: "lookup",
        executor: {
          async dispatch(): Promise<SkillDispatchResult> {
            return {
              disposition: "settled",
              outcome: {
                status: "completed",
                outputs: { status: "ready" },
                guidance: [{ action: "Use the lookup status in the final answer." }],
              },
            };
          },
        },
      },
    ]);
    const composer: ConversationTurnComposer = {
      async compose({ turn }) {
        const { text, metadata } = await gateway.complete({
          systemPrompt: "Compose the final assistant answer from the turn context.",
          messages: [
            ...turn.history,
            { role: "user", content: turn.inputEvent.content },
          ],
        });
        return { answer: text, metadata };
      },
    };

    const result = await new DefaultConversationEngine().processTurn({
      agent: { id: "agent_kit", name: "Kit Assistant" },
      sessionId: "session_kit",
      inputEvent: { id: "input_kit", kind: "message", content: "Can the kit run a turn?" },
      skills: [{ name: "lookup", description: "Looks up status" }],
      directives: [{ name: "brief", condition: { kind: "always" }, action: "Answer briefly." }],
      stores,
      modelGateway: gateway,
      directiveMatcher: {
        async match({ directives }) {
          return new AlwaysMatchDirectiveMatcher().match({ turnContext: {}, directives });
        },
      },
      selector,
      dispatcher: createRegistryDispatcher(registry),
      composer,
    });

    expect(result.response.answer).toBe("The kit completed the turn.");
    expect(result.response.metadata).toMatchObject({
      provider: "openai",
      model: "gpt-e2e",
      usage: { totalTokens: 26 },
    });
    expect(provider.chat.completions.create).toHaveBeenCalledWith({
      model: "gpt-e2e",
      messages: [
        { role: "system", content: "Compose the final assistant answer from the turn context." },
        { role: "user", content: "Can the kit run a turn?" },
      ],
      reasoning_effort: "medium",
    });
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
    expect(stores.listEvents("session_kit").map((event) => event.role)).toEqual(["user", "assistant"]);
  });
});
