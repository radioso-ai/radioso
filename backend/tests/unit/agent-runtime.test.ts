import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_BUDGET_CEILINGS,
  AGENT_BUDGET_DEFAULTS,
  DefaultAgentRuntime,
  type AgentBudgets,
  type AgentRunOptions,
  type AgentTool,
  type AgentTraceEvent,
  type ModelToolCall,
  type ModelToolCallRequest,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";

type ScriptedTurn =
  | { say: string; tools?: ModelToolCall[] }
  | ((req: ModelToolCallRequest) => Promise<ModelToolCallResponse> | ModelToolCallResponse);

const makeGateway = (script: ScriptedTurn[]): ModelToolCallingGateway & { calls: ModelToolCallRequest[] } => {
  let index = 0;
  const calls: ModelToolCallRequest[] = [];
  const gateway: ModelToolCallingGateway = {
    async request(req) {
      calls.push(req);
      const entry = script[index++];
      if (!entry) {
        throw new Error(`gateway: script exhausted at step ${req.stepIndex}`);
      }
      if (typeof entry === "function") {
        return entry(req);
      }
      return { assistantMessage: entry.say, toolCalls: entry.tools ?? [] };
    },
  };
  return Object.assign(gateway, { calls });
};

const toolCall = (toolName: string, args: unknown, callId = `c-${toolName}-${Math.random()}`): ModelToolCall => ({
  callId,
  toolName,
  rawArguments: typeof args === "string" ? args : JSON.stringify(args),
});

const echoTool = (overrides: Partial<AgentTool<{ text: string }, { echoed: string }>> = {}): AgentTool<
  { text: string },
  { echoed: string }
> => ({
  name: "echo",
  description: "Echoes back the input text",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  async invoke(input) {
    return { echoed: input.text };
  },
  ...overrides,
});

const collectTrace = () => {
  const events: AgentTraceEvent[] = [];
  return {
    events,
    sink: { emit: (event: AgentTraceEvent) => void events.push(event) },
  };
};

const runWith = async (
  gateway: ModelToolCallingGateway,
  tools: AgentTool[],
  budgets: AgentBudgets = AGENT_BUDGET_DEFAULTS,
  options: AgentRunOptions = {},
) => {
  const runtime = new DefaultAgentRuntime({ gateway });
  return runtime.run({ systemPrompt: "sys", userMessage: "go" }, tools, budgets, options);
};

describe("DefaultAgentRuntime", () => {
  describe("happy paths", () => {
    it("completes when the model emits no tool calls", async () => {
      const gateway = makeGateway([{ say: "all done" }]);
      const trace = collectTrace();

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { traceSink: trace.sink });

      expect(result.terminatedReason).toBe("completed");
      expect(result.finalMessage).toBe("all done");
      expect(result.stepsTaken).toBe(1);
      expect(trace.events.at(-1)).toMatchObject({ kind: "terminated", reason: "completed" });
    });

    it("invokes a tool then completes", async () => {
      const gateway = makeGateway([
        { say: "let me call echo", tools: [toolCall("echo", { text: "hi" }, "c1")] },
        { say: "ok all set" },
      ]);
      const trace = collectTrace();

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { traceSink: trace.sink });

      expect(result.terminatedReason).toBe("completed");
      expect(result.finalMessage).toBe("ok all set");
      expect(result.stepsTaken).toBe(2);
      const completedToolEvent = trace.events.find((e) => e.kind === "tool_call_completed");
      expect(completedToolEvent).toMatchObject({ toolName: "echo", callId: "c1", output: { echoed: "hi" } });
    });

    it("threads previous tool results into the model transcript", async () => {
      const gateway = makeGateway([
        { say: "first", tools: [toolCall("echo", { text: "abc" }, "c1")] },
        { say: "done" },
      ]);

      await runWith(gateway, [echoTool()]);

      const secondRequest = (gateway as ReturnType<typeof makeGateway>).calls[1];
      expect(secondRequest).toBeDefined();
      const toolEntry = secondRequest.transcript.find((entry) => entry.role === "tool");
      expect(toolEntry).toMatchObject({ role: "tool", callId: "c1", toolName: "echo", isError: false });
    });
  });

  describe("budget enforcement", () => {
    it("terminates on step budget exhaustion and returns partial progress", async () => {
      const looping: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
        say: "again",
        tools: [toolCall("echo", { text: "x" })],
      }));
      const gateway = makeGateway(looping);

      const result = await runWith(gateway, [echoTool()], { ...AGENT_BUDGET_DEFAULTS, maxSteps: 3 });

      expect(result.terminatedReason).toBe("step_budget_exhausted");
      expect(result.stepsTaken).toBe(3);
    });

    it("terminates on token budget exhaustion", async () => {
      const big = "a".repeat(2000);
      const heavyTool: AgentTool<{ text: string }, { payload: string }> = {
        name: "heavy",
        description: "Returns a big payload",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ payload: z.string() }),
        async invoke() {
          return { payload: big };
        },
      };
      const gateway = makeGateway([
        { say: "1", tools: [toolCall("heavy", { text: "a" })] },
        { say: "2", tools: [toolCall("heavy", { text: "b" })] },
        { say: "3", tools: [toolCall("heavy", { text: "c" })] },
        { say: "4", tools: [toolCall("heavy", { text: "d" })] },
      ]);

      const result = await runWith(gateway, [heavyTool], { ...AGENT_BUDGET_DEFAULTS, maxToolResultTokens: 1000 });

      expect(result.terminatedReason).toBe("token_budget_exhausted");
    });

    it("terminates on wall time exhaustion using an injected clock", async () => {
      const gateway = makeGateway([
        { say: "go", tools: [toolCall("echo", { text: "a" })] },
        { say: "go", tools: [toolCall("echo", { text: "b" })] },
        { say: "go", tools: [toolCall("echo", { text: "c" })] },
      ]);

      let now = 1_000;
      const result = await runWith(
        gateway,
        [echoTool()],
        { ...AGENT_BUDGET_DEFAULTS, maxWallTimeMs: 100 },
        {
          now: () => {
            now += 60;
            return now;
          },
        },
      );

      expect(result.terminatedReason).toBe("wall_time_exhausted");
    });

    it("aborts a hung gateway call when the wall-time deadline fires (mid-call, not just between steps)", async () => {
      // Gateway that never resolves on its own — only an aborted signal ends it.
      // This simulates a stalled provider/DB call. Without a deadline-derived
      // abort, the run would block forever.
      let fireDeadline: (() => void) | null = null;
      const hangingGateway: ModelToolCallingGateway = {
        request(req) {
          return new Promise((_resolve, reject) => {
            req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
      const runtime = new DefaultAgentRuntime({ gateway: hangingGateway });
      const result = await runtime.run(
        { systemPrompt: "sys", userMessage: "go" },
        [echoTool()],
        { ...AGENT_BUDGET_DEFAULTS, maxWallTimeMs: 5_000 },
        {
          // Capture the deadline callback instead of scheduling a real timer,
          // then fire it on the next microtask so the in-flight call is aborted.
          setTimer: (cb) => {
            fireDeadline = cb;
            queueMicrotask(() => fireDeadline?.());
            return 1;
          },
          clearTimer: () => {},
        },
      );

      expect(result.terminatedReason).toBe("wall_time_exhausted");
    });

    it("distinguishes caller cancellation from deadline: caller abort yields cancelled", async () => {
      const controller = new AbortController();
      const hangingGateway: ModelToolCallingGateway = {
        request(req) {
          return new Promise((_resolve, reject) => {
            req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
      const runtime = new DefaultAgentRuntime({ gateway: hangingGateway });
      const promise = runtime.run(
        { systemPrompt: "sys", userMessage: "go" },
        [echoTool()],
        { ...AGENT_BUDGET_DEFAULTS, maxWallTimeMs: 5_000 },
        {
          signal: controller.signal,
          // Never fire the deadline; the caller aborts instead.
          setTimer: () => 1,
          clearTimer: () => {},
        },
      );
      controller.abort();
      const result = await promise;

      expect(result.terminatedReason).toBe("cancelled");
    });

    it("clamps requested budgets to hard ceilings", async () => {
      const gateway = makeGateway([{ say: "done" }]);
      const trace = collectTrace();

      await runWith(
        gateway,
        [echoTool()],
        {
          maxSteps: 999,
          maxToolResultTokens: 9_999_999,
          maxWallTimeMs: 9_999_999,
        },
        { traceSink: trace.sink },
      );

      const clampEvent = trace.events.find((e) => e.kind === "budget_check" && e.budget === "clamped");
      expect(clampEvent).toBeDefined();
      if (clampEvent && clampEvent.kind === "budget_check") {
        expect(clampEvent.resolvedBudgets).toEqual(AGENT_BUDGET_CEILINGS);
      }
    });
  });

  describe("tool validation", () => {
    it("rejects an unknown tool once, lets the model recover, but terminates on a second consecutive failure of the same tool name", async () => {
      const gateway = makeGateway([
        { say: "try ghost", tools: [toolCall("ghost", { x: 1 }, "c1")] },
        { say: "try ghost again", tools: [toolCall("ghost", { x: 1 }, "c2")] },
      ]);

      const result = await runWith(gateway, [echoTool()]);

      expect(result.terminatedReason).toBe("tool_validation_failed");
    });

    it("rejects invalid arguments once and allows recovery", async () => {
      const gateway = makeGateway([
        { say: "bad call", tools: [toolCall("echo", { text: 42 }, "c1")] },
        { say: "good call", tools: [toolCall("echo", { text: "ok" }, "c2")] },
        { say: "done" },
      ]);
      const trace = collectTrace();

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { traceSink: trace.sink });

      expect(result.terminatedReason).toBe("completed");
      const rejected = trace.events.find((e) => e.kind === "tool_call_rejected");
      expect(rejected).toMatchObject({ reason: "invalid_arguments", toolName: "echo" });
      const completed = trace.events.find((e) => e.kind === "tool_call_completed");
      expect(completed).toMatchObject({ toolName: "echo" });
    });

    it("terminates after two consecutive invalid-argument failures of the same tool", async () => {
      const gateway = makeGateway([
        { say: "bad1", tools: [toolCall("echo", { text: 1 }, "c1")] },
        { say: "bad2", tools: [toolCall("echo", { text: 2 }, "c2")] },
      ]);

      const result = await runWith(gateway, [echoTool()]);

      expect(result.terminatedReason).toBe("tool_validation_failed");
    });

    it("asks for a closing answer when the run gave up mid-turn without one", async () => {
      // Measured live: Ray reached for two tools that do not exist, then a tool literally named
      // "none", and the run terminated with finalMessage null — the operator got a blank turn.
      // Every non-completed termination has this shape whenever the model was calling tools rather
      // than talking, because finalMessage only ever holds the last assistant message.
      const gateway = makeGateway([
        { say: null as unknown as string, tools: [toolCall("ghost", { x: 1 }, "c1")] },
        { say: null as unknown as string, tools: [toolCall("ghost", { x: 1 }, "c2")] },
        { say: "I could not do that; here is what I found." },
      ]);

      const result = await runWith(gateway, [echoTool()]);

      expect(result.terminatedReason).toBe("tool_validation_failed");
      expect(result.finalMessage).toBe("I could not do that; here is what I found.");
      // Offered no tools, so the closing request cannot start another tool loop.
      expect(gateway.calls.at(-1)?.toolSchemas).toEqual([]);
    });

    it("keeps the answer the model already gave rather than spending a closing call", async () => {
      const gateway = makeGateway([
        { say: "try ghost", tools: [toolCall("ghost", { x: 1 }, "c1")] },
        { say: "still cannot", tools: [toolCall("ghost", { x: 1 }, "c2")] },
      ]);

      const result = await runWith(gateway, [echoTool()]);

      expect(result.finalMessage).toBe("still cannot");
      expect(gateway.calls).toHaveLength(2);
    });

    it("keeps a blank turn rather than a hung one when the run is already out of time", async () => {
      // Wall time and cancellation are the two reasons a closing call is wrong: the run is out of
      // budget by definition, so one more model call is the opposite of what the caller asked for.
      const hangingGateway: ModelToolCallingGateway = {
        async request(req) {
          return new Promise((resolve, reject) => {
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      };
      const runtime = new DefaultAgentRuntime({ gateway: hangingGateway });

      const result = await runtime.run(
        { systemPrompt: "s", userMessage: "u" },
        [echoTool()],
        { ...AGENT_BUDGET_DEFAULTS, maxWallTimeMs: 20 },
        {},
      );

      expect(result.terminatedReason).toBe("wall_time_exhausted");
      expect(result.finalMessage).toBeNull();
    });

    it("rejects unparseable JSON arguments as invalid_arguments", async () => {
      const gateway = makeGateway([
        { say: "garbled", tools: [{ callId: "c1", toolName: "echo", rawArguments: "{not json" }] },
        { say: "fixed", tools: [toolCall("echo", { text: "ok" }, "c2")] },
        { say: "done" },
      ]);
      const trace = collectTrace();

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { traceSink: trace.sink });

      expect(result.terminatedReason).toBe("completed");
      const rejected = trace.events.find((e) => e.kind === "tool_call_rejected");
      expect(rejected).toMatchObject({ reason: "invalid_arguments" });
    });
  });

  describe("tool invocation failures", () => {
    it("surfaces a thrown error as a tool error and allows one recovery step", async () => {
      let invocations = 0;
      const flaky: AgentTool<{ text: string }, { ok: boolean }> = {
        name: "flaky",
        description: "Throws on first call",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        async invoke(input) {
          invocations += 1;
          if (invocations === 1) {
            throw new Error("boom");
          }
          return { ok: true };
        },
      };
      const gateway = makeGateway([
        { say: "go", tools: [toolCall("flaky", { text: "a" }, "c1")] },
        { say: "retry", tools: [toolCall("flaky", { text: "b" }, "c2")] },
        { say: "done" },
      ]);

      const result = await runWith(gateway, [flaky]);
      expect(result.terminatedReason).toBe("completed");
      expect(invocations).toBe(2);
    });

    it("terminates when the model retries the same tool with the same arguments after a throw", async () => {
      const always: AgentTool<{ text: string }, { ok: boolean }> = {
        name: "always",
        description: "Always throws",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        async invoke() {
          throw new Error("nope");
        },
      };
      const gateway = makeGateway([
        { say: "go", tools: [toolCall("always", { text: "x" }, "c1")] },
        { say: "retry exactly", tools: [toolCall("always", { text: "x" }, "c2")] },
      ]);

      const result = await runWith(gateway, [always]);
      expect(result.terminatedReason).toBe("tool_invocation_failed");
    });
  });

  describe("cancellation", () => {
    it("terminates with cancelled when the signal is already aborted at start", async () => {
      const controller = new AbortController();
      controller.abort();
      const gateway = makeGateway([{ say: "should not run" }]);

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { signal: controller.signal });

      expect(result.terminatedReason).toBe("cancelled");
    });

    it("terminates with cancelled after the in-flight tool settles", async () => {
      const controller = new AbortController();
      const gateway = makeGateway([
        async (req) => {
          if (req.stepIndex === 0) {
            controller.abort();
            return { assistantMessage: "go", toolCalls: [toolCall("echo", { text: "a" }, "c1")] };
          }
          return { assistantMessage: "should not see this", toolCalls: [] };
        },
      ]);

      const result = await runWith(gateway, [echoTool()], AGENT_BUDGET_DEFAULTS, { signal: controller.signal });

      expect(result.terminatedReason).toBe("cancelled");
    });
  });

  describe("streaming variant", () => {
    it("emits events in order and resolves the same result as run()", async () => {
      const runtime = new DefaultAgentRuntime({
        gateway: makeGateway([
          { say: "first", tools: [toolCall("echo", { text: "a" }, "c1")] },
          { say: "done" },
        ]),
      });

      const stream = runtime.runStreaming({ systemPrompt: "sys", userMessage: "go" }, [echoTool()], AGENT_BUDGET_DEFAULTS);
      const events: AgentTraceEvent[] = [];
      for await (const event of stream.events) {
        events.push(event);
      }
      const result = await stream.result;

      expect(result.terminatedReason).toBe("completed");
      const firstStep = events.find((e) => e.kind === "step_started");
      expect(firstStep).toMatchObject({ kind: "step_started", stepIndex: 0 });
      expect(events.at(-1)).toMatchObject({ kind: "terminated", reason: "completed" });
      const completed = events.find((e) => e.kind === "tool_call_completed");
      expect(completed).toBeDefined();
    });

    it("run() is observable through a traceSink in the same order as runStreaming()", async () => {
      const script: ScriptedTurn[] = [
        { say: "first", tools: [toolCall("echo", { text: "a" }, "c1")] },
        { say: "done" },
      ];

      const trace = collectTrace();
      const runtime = new DefaultAgentRuntime({ gateway: makeGateway(script) });
      await runtime.run({ systemPrompt: "sys", userMessage: "go" }, [echoTool()], AGENT_BUDGET_DEFAULTS, {
        traceSink: trace.sink,
      });

      const stream = new DefaultAgentRuntime({ gateway: makeGateway(script) }).runStreaming(
        { systemPrompt: "sys", userMessage: "go" },
        [echoTool()],
        AGENT_BUDGET_DEFAULTS,
      );
      const streamEvents: AgentTraceEvent[] = [];
      for await (const event of stream.events) {
        streamEvents.push(event);
      }
      await stream.result;

      expect(trace.events.map((e) => e.kind)).toEqual(streamEvents.map((e) => e.kind));
    });
  });

  describe("token accounting", () => {
    it("prefers estimatedResultTokens over the byte heuristic when provided", async () => {
      const lyingTool: AgentTool<{ text: string }, { x: string }> = {
        name: "lying",
        description: "Reports a fixed estimate regardless of output size",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ x: z.string() }),
        estimatedResultTokens: () => 100,
        async invoke() {
          return { x: "tiny" };
        },
      };
      const gateway = makeGateway([
        { say: "1", tools: [toolCall("lying", { text: "a" })] },
        { say: "2", tools: [toolCall("lying", { text: "b" })] },
        { say: "3", tools: [toolCall("lying", { text: "c" })] },
      ]);

      const result = await runWith(gateway, [lyingTool], { ...AGENT_BUDGET_DEFAULTS, maxToolResultTokens: 150 });

      expect(result.terminatedReason).toBe("token_budget_exhausted");
      expect(result.toolResultTokensUsed).toBeGreaterThanOrEqual(150);
    });
  });
});
