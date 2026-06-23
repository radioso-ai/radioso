import { describe, expect, it } from "vitest";

import {
  createDefaultSkillCapabilityRegistry,
  type SkillCapabilityDescriptor,
  skillCapabilityIds,
} from "../../../src/modules/skills/capabilityRegistry.js";

const rootSettingKey = (key: string) => key.split(".")[0] ?? key;

const hasInnerType = (value: unknown): value is { innerType: () => unknown } =>
  value !== null && typeof value === "object" && "innerType" in value &&
  typeof (value as { innerType?: unknown }).innerType === "function";

const hasShape = (value: unknown): value is { shape: Record<string, unknown> } =>
  value !== null && typeof value === "object" && "shape" in value &&
  typeof (value as { shape?: unknown }).shape === "object";

const configSchemaKeys = (descriptor: SkillCapabilityDescriptor): Set<string> => {
  const schema = hasInnerType(descriptor.configSchema)
    ? descriptor.configSchema.innerType()
    : descriptor.configSchema;
  const shape = hasShape(schema)
    ? schema.shape
    : undefined;
  if (!shape || typeof shape !== "object") {
    return new Set();
  }
  return new Set(Object.keys(shape));
};

describe("SkillCapabilityRegistry", () => {
  it("maps public capability ids to stored agent_skills kinds in one place", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.get("retrieve")?.storedKind).toBe("retrieve");
    expect(registry.get("mcp_tool")?.storedKind).toBe("external_mcp");
    expect(registry.get("email")?.storedKind).toBe("customer_email");
    expect(registry.get("slack_post")?.storedKind).toBe("slack");
    expect(registry.get("webhook_call")?.storedKind).toBe("webhook");
    expect(registry.get("notify")?.storedKind).toBe("notify");
    expect(registry.getByStoredKind("retrieve")?.id).toBe("retrieve");
    expect(registry.getByStoredKind("external_mcp")?.id).toBe("mcp_tool");
    expect(registry.getByStoredKind("customer_email")?.id).toBe("email");
    expect(registry.getByStoredKind("slack")?.id).toBe("slack_post");
    expect(registry.getByStoredKind("webhook")?.id).toBe("webhook_call");
    expect(registry.getByStoredKind("notify")?.id).toBe("notify");
  });

  it("projects all F0 capability descriptors with target kind, schemas, outcomes, modes, and executor adapter", () => {
    const registry = createDefaultSkillCapabilityRegistry();
    const descriptors = registry.list();

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([...skillCapabilityIds]);
    for (const descriptor of descriptors) {
      expect(descriptor.targetKind).toEqual(expect.any(String));
      expect(descriptor.requiresTarget).toEqual(expect.any(Boolean));
      expect(descriptor.inputSchema).toBeDefined();
      expect(descriptor.outcomeVocabulary.length).toBeGreaterThan(0);
      expect(descriptor.supportedInvocationModes).toContain("routine_named");
      expect(descriptor.supportedInvocationModes).toContain("agent_selectable");
      expect(descriptor.defaultInvocationMode ?? descriptor.supportedInvocationModes[0]).toBeTypeOf("string");
      expect(descriptor.executorAdapter).toEqual(expect.any(String));
    }
    expect(registry.get("notify")?.requiresTarget).toBe(false);
    expect(registry.get("retrieve")?.requiresTarget).toBe(false);
    expect(registry.get("email")?.requiresTarget).toBe(true);
  });

  it("enforces supported invocation modes by capability", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.supportsInvocationMode("retrieve", "default_answer")).toBe(true);
    expect(registry.supportsInvocationMode("retrieve", "routine_named")).toBe(true);
    expect(registry.supportsInvocationMode("retrieve", "agent_selectable")).toBe(true);
    expect(registry.supportsInvocationMode("mcp_tool", "routine_named")).toBe(true);
    expect(registry.supportsInvocationMode("mcp_tool", "agent_selectable")).toBe(true);
    expect(registry.supportsInvocationMode("mcp_tool", "default_answer")).toBe(false);
  });

  it("validates capability config with each descriptor schema", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.get("retrieve")?.validateConfig({
      sourceScope: { sourceIds: ["2e0c6264-f2c4-4549-bcd8-bf2f7d1a0d1e"] },
      instruction: "Use event sources only.",
      retrievalStrategy: "fixed",
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 6,
      queryRewriteEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 2,
      exposedInputs: { query: true },
    }).success).toBe(true);

    expect(registry.get("retrieve")?.validateConfig({
      sourceScope: "all",
      similarityThreshold: 0.42,
      exposedInputs: { query: true },
    }).success).toBe(false);

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

    expect(registry.get("notify")?.validateConfig({
      delivery: {
        recipientEmails: ["sales@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
      exposedInputs: { message: true, email: true },
    }).success).toBe(true);

    expect(registry.get("notify")?.validateConfig({
      delivery: { recipientEmails: ["not-an-email"], webhook: null },
      exposedInputs: { message: true },
    }).success).toBe(false);
  });

  it("keeps descriptor settings fields aligned with config schemas", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    for (const descriptor of registry.list()) {
      const configKeys = configSchemaKeys(descriptor);
      expect(configKeys.size, `${descriptor.id} config schema keys`).toBeGreaterThan(0);
      for (const field of descriptor.settingsFields) {
        expect(configKeys.has(rootSettingKey(field.key)), `${descriptor.id}.${field.key}`).toBe(true);
      }
    }

    const retrieveSettings = registry.get("retrieve")?.settingsFields.map((field) => field.key) ?? [];
    expect(retrieveSettings).toContain("sourceScope");
    expect(retrieveSettings).toContain("instruction");
    expect(retrieveSettings).toContain("suggestedQuestionsCount");
    expect(retrieveSettings).not.toContain("similarityThreshold");
    expect(registry.get("retrieve")?.defaultInvocationMode).toBe("default_answer");
    expect(registry.get("email")?.defaultInvocationMode).toBe("routine_named");
    const retrieveEssentialSettings = registry.get("retrieve")?.settingsFields
      .filter((field) => field.advanced !== true)
      .map((field) => field.key) ?? [];
    const retrieveAdvancedSettings = registry.get("retrieve")?.settingsFields
      .filter((field) => field.advanced === true)
      .map((field) => field.key) ?? [];
    expect(retrieveEssentialSettings).toEqual(["sourceScope", "instruction", "suggestedQuestionsEnabled"]);
    expect(retrieveAdvancedSettings).toEqual(expect.arrayContaining([
      "vectorTopK",
      "rerankEnabled",
      "rerankTopK",
      "queryRewriteEnabled",
      "semanticRewriteInstructions",
      "lexicalRewriteInstructions",
      "suggestedQuestionsCount",
    ]));
  });
});
