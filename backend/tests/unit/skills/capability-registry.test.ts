import { describe, expect, it } from "vitest";

import {
  createDefaultSkillCapabilityRegistry,
  skillCapabilityIds,
} from "../../../src/modules/skills/capabilityRegistry.js";

describe("SkillCapabilityRegistry", () => {
  it("maps public capability ids to stored agent_skills kinds in one place", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.get("mcp_tool")?.storedKind).toBe("external_mcp");
    expect(registry.get("email")?.storedKind).toBe("customer_email");
    expect(registry.get("slack_post")?.storedKind).toBe("slack");
    expect(registry.get("webhook_call")?.storedKind).toBe("webhook");
    expect(registry.getByStoredKind("external_mcp")?.id).toBe("mcp_tool");
    expect(registry.getByStoredKind("customer_email")?.id).toBe("email");
    expect(registry.getByStoredKind("slack")?.id).toBe("slack_post");
    expect(registry.getByStoredKind("webhook")?.id).toBe("webhook_call");
  });

  it("projects all F0 capability descriptors with target kind, schemas, outcomes, modes, and executor adapter", () => {
    const registry = createDefaultSkillCapabilityRegistry();
    const descriptors = registry.list();

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([...skillCapabilityIds]);
    for (const descriptor of descriptors) {
      expect(descriptor.targetKind).toEqual(expect.any(String));
      expect(descriptor.inputSchema).toBeDefined();
      expect(descriptor.outcomeVocabulary.length).toBeGreaterThan(0);
      expect(descriptor.supportedInvocationModes).toContain("routine_named");
      expect(descriptor.supportedInvocationModes).toContain("agent_selectable");
      expect(descriptor.executorAdapter).toEqual(expect.any(String));
    }
  });

  it("enforces supported invocation modes by capability", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.supportsInvocationMode("mcp_tool", "routine_named")).toBe(true);
    expect(registry.supportsInvocationMode("mcp_tool", "agent_selectable")).toBe(true);
    expect(registry.supportsInvocationMode("mcp_tool", "default_answer")).toBe(false);
  });

  it("validates capability config with each descriptor schema", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.get("email")?.validateConfig({
      mode: "draft",
      boundInputs: { to: "lead@example.com", subject: "Hello", bodyText: "Hi" },
      exposedInputs: {},
    }).success).toBe(true);

    expect(registry.get("email")?.validateConfig({
      mode: "send",
      boundInputs: { to: "lead@example.com" },
      exposedInputs: {},
    }).success).toBe(false);

    expect(registry.get("webhook_call")?.validateConfig({
      boundPayload: { source: "routine" },
      exposedPayload: { email: { required: true } },
    }).success).toBe(true);
  });
});
