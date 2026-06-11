import { describe, expect, it } from "vitest";

import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import {
  AGENT_CONFIG_FIELD_DESCRIPTORS,
  AGENT_CONFIG_SCHEMA_VERSION,
  applyAgentConfigOverride,
  materializeAgentFromConfig,
  projectInternalAgentConfig,
  serializeAgentConfig,
} from "../../src/modules/agents/agentConfig.js";

const fullyConfiguredAgent = (): ConversationAgent => ({
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "Support Bot",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  customInstruction: "Answer with precise procurement guidance.",
  suggestedQuestionsEnabled: false,
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: false,
  contactRequestsEnabled: true,
  webhookExportsEnabled: true,
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
    model: "gpt-5-mini",
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
    id: "agent-1:directive:0",
    agentId: "agent-1",
    name: "procurement-tone",
    condition: { kind: "contextual", description: "When answering procurement questions" },
    action: "Use the procurement team's preferred tone.",
    priority: 50,
    requiredCapabilities: ["retrieval.answer"],
    dependsOn: ["represent-organization"],
    excludes: [],
    routes: ["retrieval"],
    tags: ["step:contact:ask_email"],
    description: "Operator-authored behavior rule.",
    metadata: { owner: "ops" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }],
});

describe("applyAgentConfigOverride", () => {
  it("deep-merges object fields while preserving undefined and applying null", () => {
    const baseline = projectInternalAgentConfig(fullyConfiguredAgent());

    const merged = applyAgentConfigOverride(baseline, {
      name: "Replay Bot",
      logo: null,
      branding: {
        privacyPolicyUrl: undefined,
      },
      theme: {
        brand: "#abcdef",
      },
      chatModelOverride: null,
    } as unknown as Partial<typeof baseline>);

    expect(merged.name).toBe("Replay Bot");
    expect(merged.logo).toBeNull();
    expect(merged.branding).toEqual(baseline.branding);
    expect(merged.theme).toEqual({
      ...baseline.theme,
      brand: "#abcdef",
    });
    expect(merged.chatModelOverride).toBeNull();
    expect(baseline.logo).not.toBeNull();
  });

  it("deep-merges skill settings per skill envelope without wiping sibling settings", () => {
    const baseline = projectInternalAgentConfig(fullyConfiguredAgent());

    const merged = applyAgentConfigOverride(baseline, {
      skillSettings: {
        "retrieval.answer": {
          settings: {
            vectorTopK: 3,
            __agentRetrievalDefaults: {
              sourceScope: {
                mode: "selected",
                sourceIds: ["replacement-source"],
              },
            },
          },
        },
      },
    } as unknown as Partial<typeof baseline>);

    expect(merged.skillSettings["retrieval.answer"]).toEqual({
      enabled: true,
      settings: {
        vectorTopK: 3,
        suggestedQuestionsCount: 4,
        __agentRetrievalDefaults: {
          sourceScope: {
            mode: "selected",
            sourceIds: ["replacement-source"],
          },
          suggestedQuestionsEnabled: false,
          citationDisplayEnabled: false,
          assistantLinkUtmEnabled: false,
        },
      },
    });
  });

  it("replaces arrays wholesale and never lets overrides change schemaVersion or portability", () => {
    const baseline = projectInternalAgentConfig(fullyConfiguredAgent());

    const merged = applyAgentConfigOverride(baseline, {
      schemaVersion: 999,
      portability: { name: "secret" },
      authoredDirectives: [],
      skillSettings: {
        "retrieval.answer": {
          settings: {
            __agentRetrievalDefaults: {
              sourceScope: {
                mode: "selected",
                sourceIds: ["only-source"],
              },
            },
          },
        },
      },
    } as unknown as Partial<typeof baseline>);

    expect(merged.authoredDirectives).toEqual([]);
    expect(merged.skillSettings["retrieval.answer"].settings.__agentRetrievalDefaults.sourceScope).toEqual({
      mode: "selected",
      sourceIds: ["only-source"],
    });
    expect(merged.schemaVersion).toBe(baseline.schemaVersion);
    expect(merged.portability).toEqual(baseline.portability);
  });
});

describe("serializeAgentConfig", () => {
  it("projects every persisted agent setting into a versioned export-ready config", () => {
    const config = serializeAgentConfig(fullyConfiguredAgent());

    expect(config.schemaVersion).toBe(AGENT_CONFIG_SCHEMA_VERSION);
    expect(config.schemaVersion).toBe(2);
    expect(config.name).toBe("Support Bot");
    expect(config.customInstruction).toBe("Answer with precise procurement guidance.");
    expect(config.contactRequestsEnabled).toBe(true);
    expect(config.webhookExportsEnabled).toBe(true);
    expect(config.contactRequestDelivery).toEqual({
      recipientEmails: ["help@example.com"],
      webhook: { url: "https://hooks.example.com/contact" },
    });
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
        enabled: true,
        settings: {
          vectorTopK: 9,
          suggestedQuestionsCount: 4,
          __agentRetrievalDefaults: {
            sourceScope: {
              mode: "selected",
              sourceIds: [{ __ref: "documentSource" }, { __ref: "documentSource" }],
            },
            suggestedQuestionsEnabled: false,
            citationDisplayEnabled: false,
            assistantLinkUtmEnabled: false,
          },
        },
      },
    });
    expect(config.chatModelOverride).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
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
      requiredCapabilities: ["retrieval.answer"],
      dependsOn: ["represent-organization"],
      excludes: [],
      routes: ["retrieval"],
      tags: ["step:contact:ask_email"],
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
    expect(config.portability["skillSettings[\"retrieval.answer\"].settings.__agentRetrievalDefaults.sourceScope.sourceIds"]).toBe("ref");
    expect(config.portability["logo.bucket"]).toBe("ref");
    expect(config.portability["logo.objectPath"]).toBe("ref");
    expect(config.portability["logo.generation"]).toBe("ref");
    expect(config.portability["surfaceSettings.websiteEmbed.allowedOrigins"]).toBe("ref");

    expect(config.surfaceSettings.anonymousChat.token).toEqual({ __redacted: "secret" });
    expect(config.surfaceSettings.websiteEmbed.token).toEqual({ __redacted: "secret" });
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

  it("round-trips behavioral fields through the non-redacting internal projection", () => {
    const agent = fullyConfiguredAgent();
    const config = projectInternalAgentConfig(agent);

    expect(config.surfaceSettings.anonymousChat.token).toBe("raw-anonymous-token");
    expect(config.surfaceSettings.websiteEmbed.token).toBe("raw-embed-token");
    expect(config.surfaceSettings.websiteEmbed.allowedOrigins).toEqual(["https://raw-origin.example.com"]);
    expect(config.skillSettings["retrieval.answer"]).toEqual({
      enabled: true,
      settings: {
        vectorTopK: 9,
        suggestedQuestionsCount: 4,
        __agentRetrievalDefaults: {
          sourceScope: {
            mode: "selected",
            sourceIds: ["raw-source-1", "raw-source-2"],
          },
          suggestedQuestionsEnabled: false,
          citationDisplayEnabled: false,
          assistantLinkUtmEnabled: false,
        },
      },
    });
    expect(config.logo).toEqual({
      bucket: "raw-logo-bucket",
      objectPath: "raw/logo/object.png",
      generation: "raw-generation-1",
      mimeType: "image/png",
      filename: "logo.png",
      sizeBytes: 12345,
    });

    const materialized = materializeAgentFromConfig(config, { agentId: agent.id, workspaceId: agent.workspaceId });

    expect(materialized).toEqual(agent);
    expect(materialized.id).toBe(agent.id);
    expect(materialized.workspaceId).toBe(agent.workspaceId);
    expect(materialized.name).toBe(agent.name);
    expect(materialized.customInstruction).toBe(agent.customInstruction);
    expect(materialized.greetingInstruction).toBe(agent.greetingInstruction);
    expect(materialized.sourceScope).toEqual(agent.sourceScope);
    expect(materialized.retrievalEnabled).toBe(agent.retrievalEnabled);
    expect(materialized.assistantDefaultLocale).toBe(agent.assistantDefaultLocale);
    expect(materialized.skillSettings).toEqual(agent.skillSettings);
    expect(materialized.chatModelOverride).toEqual(agent.chatModelOverride);
    expect(materialized.suggestedQuestionsEnabled).toBe(agent.suggestedQuestionsEnabled);
    expect(materialized.citationDisplayEnabled).toBe(agent.citationDisplayEnabled);
    expect(materialized.contactRequestsEnabled).toBe(agent.contactRequestsEnabled);
    expect(materialized.webhookExportsEnabled).toBe(agent.webhookExportsEnabled);
    expect(materialized.proactiveGreetingEnabled).toBe(agent.proactiveGreetingEnabled);
    expect(materialized.assistantLinkUtmEnabled).toBe(agent.assistantLinkUtmEnabled);
    expect(materialized.logo).toEqual(agent.logo);
    expect(materialized.theme).toEqual(agent.theme);
    expect(materialized.branding).toEqual(agent.branding);
    expect(materialized.surfaceSettings).toEqual(agent.surfaceSettings);
    const materializedDirectives = materialized.authoredDirectives ?? [];
    expect(materializedDirectives[0]?.agentId).toBe(agent.id);
    expect(materializedDirectives).toEqual([{
      id: `${agent.id}:directive:0`,
      agentId: agent.id,
      name: "procurement-tone",
      condition: { kind: "contextual", description: "When answering procurement questions" },
      action: "Use the procurement team's preferred tone.",
      priority: 50,
      requiredCapabilities: ["retrieval.answer"],
      dependsOn: ["represent-organization"],
      excludes: [],
      routes: ["retrieval"],
      tags: ["step:contact:ask_email"],
      description: "Operator-authored behavior rule.",
      metadata: { owner: "ops" },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }]);
  });

  it("round-trips divergent agent-level and retrieval skill suggested question flags", () => {
    const agent: ConversationAgent = {
      ...fullyConfiguredAgent(),
      suggestedQuestionsEnabled: true,
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 11,
          suggestedQuestionsEnabled: false,
        },
      },
    };

    const config = projectInternalAgentConfig(agent);
    const retrievalEnvelope = config.skillSettings["retrieval.answer"];

    expect(retrievalEnvelope).toEqual({
      enabled: true,
      settings: {
        vectorTopK: 11,
        suggestedQuestionsEnabled: false,
        __agentRetrievalDefaults: {
          sourceScope: {
            mode: "selected",
            sourceIds: ["raw-source-1", "raw-source-2"],
          },
          suggestedQuestionsEnabled: true,
          citationDisplayEnabled: false,
          assistantLinkUtmEnabled: false,
        },
      },
    });

    const materialized = materializeAgentFromConfig(config, { agentId: agent.id, workspaceId: agent.workspaceId });

    expect(materialized).toEqual(agent);
    expect(materialized.suggestedQuestionsEnabled).toBe(true);
    expect(materialized.skillSettings["retrieval.answer"]).toEqual({
      vectorTopK: 11,
      suggestedQuestionsEnabled: false,
    });
    expect(
      (materialized.skillSettings["retrieval.answer"] as Record<string, unknown>).suggestedQuestionsEnabled,
    ).toBe(false);
  });

  it("materializes partial authored directive overrides with defensive defaults", () => {
    const agent = fullyConfiguredAgent();
    const config = {
      ...projectInternalAgentConfig(agent),
      authoredDirectives: [{
        name: "preview-draft",
        condition: { kind: "always" },
        action: "Use the draft behavior.",
        tags: ["step:onboarding:answer"],
      }],
    } as ReturnType<typeof projectInternalAgentConfig>;

    const materialized = materializeAgentFromConfig(config, {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
    });

    expect(materialized.authoredDirectives).toEqual([{
      id: `${agent.id}:directive:0`,
      agentId: agent.id,
      name: "preview-draft",
      condition: { kind: "always" },
      action: "Use the draft behavior.",
      priority: null,
      requiredCapabilities: [],
      dependsOn: [],
      excludes: [],
      routes: [],
      tags: ["step:onboarding:answer"],
      description: null,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }]);
  });
});
