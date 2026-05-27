import { describe, expect, it } from "vitest";

import {
  SkillExecutorRegistry,
  type SkillExecutorPort,
} from "../../src/modules/skills/public.js";

const noopExecutor = (label: string): SkillExecutorPort => ({
  async execute() {
    return { answer: label };
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
