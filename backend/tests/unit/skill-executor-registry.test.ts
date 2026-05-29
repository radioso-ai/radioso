import { describe, expect, it } from "vitest";

import {
  SkillExecutorRegistry,
  type SkillDispatchResult,
  type SkillExecutorPort,
} from "../../src/modules/skills/public.js";

const noopExecutor = (label: string): SkillExecutorPort => ({
  async dispatch(): Promise<SkillDispatchResult> {
    return { disposition: "settled", outcome: { status: "completed", answer: label } };
  },
});

describe("SkillExecutorRegistry", () => {
  it("resolves an executor by execution kind and adapter", () => {
    const registry = new SkillExecutorRegistry();
    const pipeline = noopExecutor("delivered");
    const internal = noopExecutor("ok");

    registry.register({ kind: "delivery_pipeline", adapter: "human_contact", executor: pipeline });
    registry.register({ kind: "internal", adapter: "echo", executor: internal });

    expect(registry.resolve({
      kind: "delivery_pipeline",
      adapter: "human_contact",
      destinations: ["email"],
      enqueue: true,
    })).toBe(pipeline);
    expect(registry.resolve({
      kind: "internal",
      adapter: "echo",
    })).toBe(internal);
  });

  it("returns null when no executor matches", () => {
    const registry = new SkillExecutorRegistry();
    expect(registry.resolve({
      kind: "internal",
      adapter: "missing",
    })).toBeNull();
  });

  it("rejects duplicate (kind, adapter) registrations", () => {
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter: "echo", executor: noopExecutor("first") });

    expect(() =>
      registry.register({ kind: "internal", adapter: "echo", executor: noopExecutor("second") }),
    ).toThrow(/already registered/);
  });

  it("resolves webhook executors keyed by provider", () => {
    const registry = new SkillExecutorRegistry();
    const executor = noopExecutor("webhooked");
    registry.register({ kind: "webhook", provider: "make", executor });

    expect(registry.resolve({
      kind: "webhook",
      provider: "make",
      endpointId: "endpoint-1",
      enqueue: false,
    })).toBe(executor);
  });
});

describe("skill-invocation port shape", () => {
  it("hands the executor an emit port and returns a settled control envelope", async () => {
    const emitted: string[] = [];
    const executor: SkillExecutorPort = {
      async dispatch(invocation): Promise<SkillDispatchResult> {
        await invocation.emit.emitStatus("working", { skill: invocation.skill.name });
        emitted.push("status");
        return {
          disposition: "settled",
          outcome: {
            status: "completed",
            answer: "done",
            outputs: { ok: true },
            control: { sessionMode: "manual", lifespan: "session" },
            guidance: [{ action: "stay formal" }],
            metadata: { traceId: "abc" },
          },
        };
      },
    };

    const result = await executor.dispatch({
      skill: { name: "demo" } as never,
      collected: {},
      emit: {
        async emitStatus() {},
        async emitCustom() {},
      },
    });

    expect(emitted).toEqual(["status"]);
    expect(result.disposition).toBe("settled");
    if (result.disposition === "settled") {
      expect(result.outcome.control?.sessionMode).toBe("manual");
      expect(result.outcome.metadata).toEqual({ traceId: "abc" });
    }
  });

  it("admits a deferred disposition in the port type (no async engine exercised)", async () => {
    // The async weave must be expressible against the real port without a
    // breaking change. No shipped executor returns this today.
    const deferredExecutor: SkillExecutorPort = {
      async dispatch(): Promise<SkillDispatchResult> {
        return { disposition: "deferred", ticket: { ticketId: "order-status-1" } };
      },
    };

    const result = await deferredExecutor.dispatch({
      skill: { name: "order_status" } as never,
      collected: {},
      emit: {
        async emitStatus() {},
        async emitCustom() {},
      },
    });

    expect(result.disposition).toBe("deferred");
    if (result.disposition === "deferred") {
      expect(result.ticket.ticketId).toBe("order-status-1");
    }
  });
});
