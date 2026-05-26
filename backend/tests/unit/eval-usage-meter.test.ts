import { describe, expect, it, vi } from "vitest";

import { EvalUsageMeter } from "../../src/modules/eval/services/evalUsageMeter.js";
import type { LlmCapabilityResolver } from "../../src/shared/infra/llm/capabilityResolver.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";

const buildResolver = (provider: string, model: string): LlmCapabilityResolver => ({
  async resolve() {
    return { provider, model, apiKey: "test", baseUrl: undefined } as any;
  },
});

const buildRecorder = () => {
  const events: ModelUsageEvent[] = [];
  const recorder: UsageEventRecorder = {
    async recordEmbedding() {},
    async recordModelCall(event) {
      events.push(event);
    },
  };
  return { recorder, events };
};

describe("EvalUsageMeter", () => {
  it("records a ModelUsageEvent with provider, model, bytes, and estimated tokens", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver("openai", "gpt-4o-mini"));

    await meter.record(
      {
        workspaceId: "ws-1",
        accountId: "acc-1",
        runId: "run-1",
        operation: "full_assistant_answer",
        attemptKey: "answer",
      },
      {
        promptText: "system\n\nuser question goes here", // 32 bytes
        responseText: "the assistant answers here", // 26 bytes
        status: "succeeded",
      },
    );

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.workspaceId).toBe("ws-1");
    expect(event.accountId).toBe("acc-1");
    expect(event.surface).toBe("eval");
    expect(event.operation).toBe("full_assistant_answer");
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-4o-mini");
    expect(event.inputBytes).toBeGreaterThan(0);
    expect(event.outputBytes).toBeGreaterThan(0);
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.outputTokens).toBeGreaterThan(0);
    expect(event.usageQuality).toBe("estimated");
    expect(event.status).toBe("succeeded");
    expect(event.idempotencyKey).toBe("eval:run:run-1:full_assistant_answer:answer");
  });

  it("uses a distinct idempotency key per judge assertion within the same run", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver("openai", "gpt-4o-mini"));

    await meter.record(
      {
        workspaceId: "ws-1",
        runId: "run-1",
        operation: "llm_judge",
        attemptKey: "assertion-0",
      },
      { promptText: "p", responseText: "r", status: "succeeded" },
    );
    await meter.record(
      {
        workspaceId: "ws-1",
        runId: "run-1",
        operation: "llm_judge",
        attemptKey: "assertion-1",
      },
      { promptText: "p", responseText: "r", status: "succeeded" },
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.idempotencyKey).toBe("eval:run:run-1:llm_judge:assertion-0");
    expect(events[1]!.idempotencyKey).toBe("eval:run:run-1:llm_judge:assertion-1");
  });

  it("records failed calls so EE-side metering still sees the provider hit", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver("openai", "gpt-4o-mini"));

    await meter.record(
      {
        workspaceId: "ws-1",
        runId: "run-1",
        operation: "full_assistant_answer",
        attemptKey: "answer",
      },
      {
        promptText: "prompt",
        responseText: "",
        status: "failed",
        errorCode: "provider 500",
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("failed");
    expect(events[0]!.errorCode).toBe("provider 500");
  });

  it("falls back to provider='unknown' when the capability resolver throws", async () => {
    const { recorder, events } = buildRecorder();
    const broken: LlmCapabilityResolver = {
      async resolve() { throw new Error("no provider configured"); },
    };
    const meter = new EvalUsageMeter(recorder, broken);

    await meter.record(
      {
        workspaceId: "ws-1",
        runId: "run-1",
        operation: "full_assistant_answer",
        attemptKey: "answer",
      },
      { promptText: "p", responseText: "r", status: "succeeded" },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("unknown");
    expect(events[0]!.model).toBe("unknown");
  });

  it("never throws when the underlying recorder throws", async () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() { throw new Error("ledger down"); },
    };
    const meter = new EvalUsageMeter(recorder, buildResolver("openai", "gpt-4o-mini"));

    await expect(
      meter.record(
        {
          workspaceId: "ws-1",
          runId: "run-1",
          operation: "full_assistant_answer",
          attemptKey: "answer",
        },
        { promptText: "p", responseText: "r", status: "succeeded" },
      ),
    ).resolves.toBeUndefined();
  });
});
