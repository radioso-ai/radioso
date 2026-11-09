import { describe, expect, it, vi } from "vitest";

import type { RoutineSelectorCompletionEvent } from "@radioso/conversation-defaults";

import { selectorCompletionTelemetry } from "../../../src/modules/routines/selectorCompletionTelemetry.js";

const event = (overrides: Partial<RoutineSelectorCompletionEvent> = {}): RoutineSelectorCompletionEvent => ({
  routineId: "booking",
  stepId: "contact",
  stepKind: "chat",
  sessionId: "conversation-1",
  call: "decision",
  model: "gpt-5.4-mini",
  stopReason: "completed",
  outputChars: 0,
  promptChars: 7095,
  ...overrides,
});

const setup = () => {
  const logger = { warn: vi.fn() };
  const metricsRegistry = { incrementCounter: vi.fn() };
  const observe = selectorCompletionTelemetry({ logger, metricsRegistry, agentId: "agent-1", workspaceId: "workspace-1" });
  return { logger, metricsRegistry, observe };
};

const counted = (metricsRegistry: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metricsRegistry.incrementCounter.mock.calls.map(([name, options]) => [name, (options as { labels: Record<string, string> }).labels]);

describe("routine selector completion telemetry (#1715)", () => {
  it("counts every completion by model, step kind, call, and whether it could be read", () => {
    const { metricsRegistry, observe } = setup();

    observe(event({ unreadableReason: "no_json_object" }));
    observe(event({ call: "retry", unreadableReason: "no_json_object" }));
    observe(event({ call: "slot_fallback", outputChars: 80 }));

    expect(counted(metricsRegistry)).toEqual([
      ["routine_next_step_completions_total", { model: "gpt-5.4-mini", step_kind: "chat", call: "decision", result: "no_json_object" }],
      ["routine_next_step_completions_total", { model: "gpt-5.4-mini", step_kind: "chat", call: "retry", result: "no_json_object" }],
      ["routine_next_step_completions_total", { model: "gpt-5.4-mini", step_kind: "chat", call: "slot_fallback", result: "read" }],
    ]);
  });

  it("labels a model outside the catalog as other, and an unreported one as unreported", () => {
    const { metricsRegistry, observe } = setup();

    observe(event({ model: "my-company/finetune-7b" }));
    observe(event({ model: undefined }));

    expect(counted(metricsRegistry).map(([, labels]) => (labels as Record<string, string>).model)).toEqual(["other", "unreported"]);
  });

  it("logs an unreadable completion with its ids, call, model, stop reason, and sizes, and a read one not at all", () => {
    const { logger, observe } = setup();

    observe(event({ call: "slot_fallback", unreadableReason: "invalid_json", outputChars: 12 }));
    observe(event({ call: "decision" }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        agentId: "agent-1",
        workspaceId: "workspace-1",
        routineId: "booking",
        stepId: "contact",
        stepKind: "chat",
        sessionId: "conversation-1",
        call: "slot_fallback",
        reason: "invalid_json",
        model: "gpt-5.4-mini",
        stopReason: "completed",
        outputChars: 12,
        promptChars: 7095,
      },
      "Routine next-step decision was unreadable",
    );
  });

  it("still logs when no metrics registry is wired", () => {
    const logger = { warn: vi.fn() };
    const observe = selectorCompletionTelemetry({ logger, metricsRegistry: null, agentId: "agent-1" });

    observe(event({ unreadableReason: "no_json_object" }));

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_json_object", call: "decision" }), expect.any(String));
  });
});
