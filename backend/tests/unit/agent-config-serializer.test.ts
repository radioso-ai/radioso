import { describe, expect, it } from "vitest";

import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import {
  AGENT_CONFIG_FIELD_DESCRIPTORS,
  AGENT_CONFIG_SCHEMA_VERSION,
  serializeAgentConfig,
} from "../../src/modules/agents/agentConfig.js";

const fullyConfiguredAgent = (): ConversationAgent => ({
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "Support Bot",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  customInstruction: "Answer with precise procurement guidance.",
  suggestedQuestionsEnabled: false,
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: false,
  contactRequestsEnabled: true,
  contactRequestDelivery: {
    recipientEmails: ["help@example.com"],
    webhook: { url: "https://hooks.example.com/contact" },
  },
  retrievalEnabled: true,
  logo: {
    bucket: "raw-logo-bucket",
    objectPath: "raw/logo/object.png",
    generation: "raw-generation-1",
    mimeType: "image/png",
    filename: "logo.png",
    sizeBytes: 12345,
  },
  theme: {
    brand: "#112233",
    brandText: "#ffffff",
    surface: "#f8fafc",
    text: "#101820",
  },
  branding: {
    hidePoweredBy: true,
    privacyPolicyUrl: "https://example.com/privacy",
  },
  greetingInstruction: "Welcome the visitor by role.",
  assistantDefaultLocale: "en-US",
  proactiveGreetingEnabled: true,
  sourceScope: {
    mode: "selected",
    sourceIds: ["raw-source-1", "raw-source-2"],
  },
  skillSettings: {
    "retrieval.answer": {
      vectorTopK: 9,
      suggestedQuestionsCount: 4,
    },
  },
  chatModelOverride: {
    provider: "openai",
    model: "gpt-4.1-mini",
  },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: {
      enabled: true,
      token: "raw-anonymous-token",
    },
    websiteEmbed: {
      enabled: true,
      token: "raw-embed-token",
      allowedOrigins: ["https://raw-origin.example.com"],
      launcherLabel: "Ask Support",
      launcherPosition: "bottom-left",
      theme: {
        brand: "#445566",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#111111",
      },
      copy: {
        "en-US": {
          title: "Support",
        },
      },
      expertOverrides: {
        sales: "Route to sales.",
      },
    },
    extensions: {
      websiteEmbed: {
        enabled: true,
        token: "raw-extension-embed-token",
        allowedOrigins: ["https://raw-extension-origin.example.com"],
        launcherLabel: "Ask Support",
        launcherPosition: "bottom-left",
        theme: {
          brand: "#445566",
          brandText: "#ffffff",
          surface: "#ffffff",
          text: "#111111",
        },
        copy: {},
        expertOverrides: {},
      },
      "custom-surface": {
        enabled: true,
        label: "Kiosk",
      },
    },
  },
  authoredDirectives: [{
    id: "directive-1",
    agentId: "agent-1",
    name: "procurement-tone",
    condition: { kind: "contextual", description: "When answering procurement questions" },
    action: "Use the procurement team's preferred tone.",
    priority: 50,
    criticality: "medium",
    requiredCapabilities: ["retrieval.answer"],
    dependsOn: ["represent-organization"],
    excludes: [],
    routes: ["retrieval"],
    description: "Operator-authored behavior rule.",
    metadata: { owner: "ops" },
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-04T00:00:00.000Z"),
  }],
});

describe("serializeAgentConfig", () => {
  it("projects every persisted agent setting into a versioned export-ready config", () => {
    const config = serializeAgentConfig(fullyConfiguredAgent());

    expect(config.schemaVersion).toBe(AGENT_CONFIG_SCHEMA_VERSION);
    expect(config.name).toBe("Support Bot");
    expect(config.customInstruction).toBe("Answer with precise procurement guidance.");
    expect(config.suggestedQuestionsEnabled).toBe(false);
    expect(config.assistantLinkUtmEnabled).toBe(false);
    expect(config.citationDisplayEnabled).toBe(false);
    expect(config.contactRequestsEnabled).toBe(true);
    expect(config.contactRequestDelivery).toEqual({
      recipientEmails: ["help@example.com"],
      webhook: { url: "https://hooks.example.com/contact" },
    });
    expect(config.retrievalEnabled).toBe(true);
    expect(config.theme).toEqual({
      brand: "#112233",
      brandText: "#ffffff",
      surface: "#f8fafc",
      text: "#101820",
    });
    expect(config.branding).toEqual({
      hidePoweredBy: true,
      privacyPolicyUrl: "https://example.com/privacy",
    });
    expect(config.greetingInstruction).toBe("Welcome the visitor by role.");
    expect(config.assistantDefaultLocale).toBe("en-US");
    expect(config.proactiveGreetingEnabled).toBe(true);
    expect(config.skillSettings).toEqual({
      "retrieval.answer": {
        vectorTopK: 9,
        suggestedQuestionsCount: 4,
      },
    });
    expect(config.chatModelOverride).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(config.surfaceSettings.authenticatedChat).toEqual({ enabled: true });
    expect(config.surfaceSettings.extensions).toEqual({
      websiteEmbed: {
        enabled: true,
        token: { __redacted: "secret" },
        allowedOrigins: [{ __ref: "websiteEmbedAllowedOrigin" }],
        launcherLabel: "Ask Support",
        launcherPosition: "bottom-left",
        theme: {
          brand: "#445566",
          brandText: "#ffffff",
          surface: "#ffffff",
          text: "#111111",
        },
        copy: {},
        expertOverrides: {},
      },
      "custom-surface": {
        enabled: true,
        label: "Kiosk",
      },
    });
    expect(config.authoredDirectives).toEqual([{
      name: "procurement-tone",
      condition: { kind: "contextual", description: "When answering procurement questions" },
      action: "Use the procurement team's preferred tone.",
      priority: 50,
      criticality: "medium",
      requiredCapabilities: ["retrieval.answer"],
      dependsOn: ["represent-organization"],
      excludes: [],
      routes: ["retrieval"],
      description: "Operator-authored behavior rule.",
      metadata: { owner: "ops" },
    }]);
  });

  it("classifies portability and never emits raw secret or reference values", () => {
    const config = serializeAgentConfig(fullyConfiguredAgent());

    expect(config.portability["name"]).toBe("portable");
    expect(config.portability["customInstruction"]).toBe("portable");
    expect(config.portability["skillSettings"]).toBe("portable");
    expect(config.portability["authoredDirectives"]).toBe("portable");
    expect(config.portability["surfaceSettings.anonymousChat.token"]).toBe("secret");
    expect(config.portability["surfaceSettings.websiteEmbed.token"]).toBe("secret");
    expect(config.portability["sourceScope.sourceIds"]).toBe("ref");
    expect(config.portability["logo.bucket"]).toBe("ref");
    expect(config.portability["logo.objectPath"]).toBe("ref");
    expect(config.portability["logo.generation"]).toBe("ref");
    expect(config.portability["surfaceSettings.websiteEmbed.allowedOrigins"]).toBe("ref");

    expect(config.surfaceSettings.anonymousChat.token).toEqual({ __redacted: "secret" });
    expect(config.surfaceSettings.websiteEmbed.token).toEqual({ __redacted: "secret" });
    expect(config.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [{ __ref: "documentSource" }, { __ref: "documentSource" }],
    });
    expect(config.logo).toEqual({
      bucket: { __ref: "storageBucket" },
      objectPath: { __ref: "storageObjectPath" },
      generation: { __ref: "storageGeneration" },
      mimeType: "image/png",
      filename: "logo.png",
      sizeBytes: 12345,
    });
    expect(config.surfaceSettings.websiteEmbed.allowedOrigins).toEqual([
      { __ref: "websiteEmbedAllowedOrigin" },
    ]);

    const serialized = JSON.stringify(config);
    for (const leakedValue of [
      "raw-anonymous-token",
      "raw-embed-token",
      "raw-extension-embed-token",
      "raw-source-1",
      "raw-source-2",
      "raw-logo-bucket",
      "raw/logo/object.png",
      "raw-generation-1",
      "https://raw-origin.example.com",
      "https://raw-extension-origin.example.com",
    ]) {
      expect(serialized).not.toContain(leakedValue);
    }
  });

  it("derives the serialized field set from the descriptor map", () => {
    const config = serializeAgentConfig(fullyConfiguredAgent());
    const configSettingFields = Object.keys(config)
      .filter((key) => key !== "schemaVersion" && key !== "portability")
      .sort();

    expect(configSettingFields).toEqual(Object.keys(AGENT_CONFIG_FIELD_DESCRIPTORS).sort());
  });
});
