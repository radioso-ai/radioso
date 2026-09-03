import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  type AgentTool,
  type ModelToolCallRequest,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";

describe("AgenticCapabilityRunner", () => {
  it("maps a skill-owned finalization into a skill-owned selection and trace", async () => {
    let finalization: { ids: string[]; note: string | null } | null = null;
    const gateway: ModelToolCallingGateway = {
      async request(input: ModelToolCallRequest): Promise<ModelToolCallResponse> {
        if (input.stepIndex === 0) {
          return {
            assistantMessage: "finalizing",
            toolCalls: [
              {
                callId: "finalize-1",
                toolName: "complete_skill",
                rawArguments: JSON.stringify({ ids: ["a"], note: "done" }),
              },
            ],
          };
        }
        return { assistantMessage: "done", toolCalls: [] };
      },
    };
    const tool: AgentTool<{ ids: string[]; note?: string }, { accepted: true }> = {
      name: "complete_skill",
      description: "Complete this test skill.",
      inputSchema: z.object({ ids: z.array(z.string()), note: z.string().optional() }),
      outputSchema: z.object({ accepted: z.literal(true) }),
      async invoke(input) {
        finalization = { ids: input.ids, note: input.note ?? null };
        return { accepted: true };
      },
    };

    const runner = new AgenticCapabilityRunner({
      runtime: new DefaultAgentRuntime({ gateway }),
    });
    const result = await runner.run(
      { systemPrompt: "sys", userMessage: "run" },
      {
        tools: [tool],
        getFinalization: () => finalization,
        mapFinalizationToSelection: (value) => value.ids.map((id) => ({ id })),
        selectFallback: () => [{ id: "fallback" }],
        mapTrace: ({ events, selection, finalization: final }) => ({
          eventKinds: events.map((event) => event.kind),
          selection,
          final,
        }),
      },
    );

    expect(result.selection).toEqual([{ id: "a" }]);
    expect(result.finalization).toEqual({ ids: ["a"], note: "done" });
    expect(result.trace.selection).toEqual([{ id: "a" }]);
    expect(result.trace.final).toEqual({ ids: ["a"], note: "done" });
    expect(result.trace.eventKinds).toContain("tool_call_completed");
    expect(result.terminatedReason).toBe("completed");
  });

  it("uses the skill-owned fallback when no finalization is accepted", async () => {
    const gateway: ModelToolCallingGateway = {
      async request(): Promise<ModelToolCallResponse> {
        return { assistantMessage: "done", toolCalls: [] };
      },
    };
    const runner = new AgenticCapabilityRunner({
      runtime: new DefaultAgentRuntime({ gateway }),
    });

    const result = await runner.run(
      { systemPrompt: "sys", userMessage: "run" },
      {
        tools: [],
        getFinalization: () => null,
        mapFinalizationToSelection: (value: { ids: string[] }) => value.ids,
        selectFallback: ({ runResult }) => [`fallback:${runResult.terminatedReason}`],
        mapTrace: ({ selection }) => ({ selection }),
      },
    );

    expect(result.selection).toEqual(["fallback:completed"]);
    expect(result.finalization).toBeNull();
    expect(result.trace.selection).toEqual(["fallback:completed"]);
  });
});

describe("AgenticCapabilityRunner final-message requirement", () => {
  const echo: AgentTool = {
    name: "echo",
    description: "echo",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    invoke: async (input) => input as { text: string },
  };

  const gateway = (calls: ModelToolCallRequest[]): ModelToolCallingGateway => ({
    async request(req): Promise<ModelToolCallResponse> {
      calls.push(req);
      if (calls.length <= 2) {
        return { assistantMessage: "", toolCalls: [{ callId: `c${calls.length}`, toolName: "ghost", rawArguments: "{}" }] };
      }
      return { assistantMessage: "could not do it", toolCalls: [] };
    },
  });

  it("forwards the requirement through run(), not only runStreaming()", async () => {
    // The option lives on the shared run input, so a caller reaching for the non-streaming path
    // would otherwise get the old blank-answer behaviour with no indication the flag was ignored.
    const calls: ModelToolCallRequest[] = [];
    const runner = new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway: gateway(calls) }) });

    const result = await runner.run(
      { systemPrompt: "s", userMessage: "u", requireFinalMessage: true },
      {
        tools: [echo],
        getFinalization: () => null,
        mapFinalizationToSelection: () => [],
        selectFallback: () => [],
        mapTrace: () => null,
      },
    );

    expect(result.runResult.finalMessage).toBe("could not do it");
    expect(calls.at(-1)?.toolSchemas).toEqual([]);
  });
});
