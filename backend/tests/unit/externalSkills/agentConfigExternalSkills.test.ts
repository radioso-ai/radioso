import { describe, expect, it } from "vitest";

import type { ConversationAgent } from "../../../src/modules/agents/domain.js";
import {
  AGENT_CONFIG_SCHEMA_VERSION,
  serializeAgentConfig,
} from "../../../src/modules/agents/agentConfig.js";
import {
  resolveExternalSkillRefs,
  serializeExternalSkills,
  type InternalAgentExternalSkillsConfig,
} from "../../../src/modules/agents/externalSkillsConfig.js";

const minimalAgent = (): ConversationAgent => ({
  id: "agent-1",
  workspaceId: "workspace-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  name: "Bot",
  customInstruction: "",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true,
  logo: null,
  theme: { brand: "#000", brandText: "#fff", surface: "#fff", text: "#000" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  sourceScope: { mode: "all" },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "",
      launcherPosition: "bottom-right",
      theme: { brand: "#000", brandText: "#fff", surface: "#fff", text: "#000" },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  skillSettings: {},
  chatModelOverride: null,
  authoredDirectives: [],
});

const externalSkillsSource = (): InternalAgentExternalSkillsConfig => ({
  connections: [
    {
      id: "conn-uuid-aaaa",
      displayName: "Slack (prod)",
      serverUrl: "https://mcp.slack.example.com",
      authMethod: "access_token",
      hasCredential: true,
    },
    {
      id: "conn-uuid-bbbb",
      displayName: "Scheduler",
      serverUrl: "https://mcp.scheduler.example.com",
      authMethod: "oauth",
      hasCredential: false,
    },
  ],
  skills: [
    {
      skillName: "handoff_slack",
      connectionId: "conn-uuid-aaaa",
      toolName: "post_message",
      boundParams: { channel: "#support" },
      exposedParams: { message: { description: "what to post" } },
      declaredOutcomes: null,
      outcomeMap: null,
      enabled: true,
    },
    {
      skillName: "book_slot",
      connectionId: "conn-uuid-bbbb",
      toolName: "create_booking",
      boundParams: {},
      exposedParams: { slot: { slotBinding: "chosen_slot" } },
      declaredOutcomes: ["booked", "taken"],
      outcomeMap: { ok: "booked" },
      enabled: false,
    },
  ],
});

describe("serializeExternalSkills", () => {
  it("redacts credentials and replaces connection ids with keyed refs", () => {
    const config = serializeExternalSkills(externalSkillsSource());

    expect(config.connections).toEqual([
      {
        key: "connection-0",
        displayName: "Slack (prod)",
        serverUrl: "https://mcp.slack.example.com",
        authMethod: "access_token",
        credential: { __redacted: "secret" },
      },
      {
        key: "connection-1",
        displayName: "Scheduler",
        serverUrl: "https://mcp.scheduler.example.com",
        authMethod: "oauth",
        credential: null,
      },
    ]);

    expect(config.skills[0]?.connection).toEqual({ __ref: "mcpConnection", key: "connection-0" });
    expect(config.skills[1]?.connection).toEqual({ __ref: "mcpConnection", key: "connection-1" });

    // No absolute connection id ever leaves the bundle.
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("conn-uuid-aaaa");
    expect(serialized).not.toContain("conn-uuid-bbbb");
  });

  it("is included in the agent config bundle with portability classification", () => {
    const config = serializeAgentConfig(minimalAgent(), { externalSkills: externalSkillsSource() });

    expect(config.schemaVersion).toBe(AGENT_CONFIG_SCHEMA_VERSION);
    expect(config.externalSkills.connections).toHaveLength(2);
    expect(config.externalSkills.skills).toHaveLength(2);
    expect(config.portability["externalSkills"]).toBe("portable");
    expect(config.portability["externalSkills.connections[].credential"]).toBe("secret");
    expect(config.portability["externalSkills.skills[].connection"]).toBe("ref");
  });

  it("defaults to an empty section when no external skills are supplied", () => {
    const config = serializeAgentConfig(minimalAgent());
    expect(config.externalSkills).toEqual({ connections: [], skills: [] });
  });
});

describe("resolveExternalSkillRefs (import re-binding)", () => {
  it("re-binds skill connection refs to newly created connection ids", () => {
    const config = serializeExternalSkills(externalSkillsSource());

    // Simulate import: connections recreated under fresh ids, keyed by bundle key.
    const keyToId = new Map([
      ["connection-0", "new-conn-1"],
      ["connection-1", "new-conn-2"],
    ]);

    const resolution = resolveExternalSkillRefs(config, keyToId);

    expect(resolution.unresolved).toEqual([]);
    expect(resolution.skills).toEqual([
      {
        skillName: "handoff_slack",
        connectionId: "new-conn-1",
        toolName: "post_message",
        boundParams: { channel: "#support" },
        exposedParams: { message: { description: "what to post" } },
        declaredOutcomes: null,
        outcomeMap: null,
        enabled: true,
      },
      {
        skillName: "book_slot",
        connectionId: "new-conn-2",
        toolName: "create_booking",
        boundParams: {},
        exposedParams: { slot: { slotBinding: "chosen_slot" } },
        declaredOutcomes: ["booked", "taken"],
        outcomeMap: { ok: "booked" },
        enabled: false,
      },
    ]);
  });

  it("reports skills whose referenced connection is absent and drops them", () => {
    const config = serializeExternalSkills(externalSkillsSource());
    const keyToId = new Map([["connection-0", "new-conn-1"]]); // connection-1 missing

    const resolution = resolveExternalSkillRefs(config, keyToId);

    expect(resolution.skills).toHaveLength(1);
    expect(resolution.skills[0]?.skillName).toBe("handoff_slack");
    expect(resolution.unresolved).toEqual([
      { skillName: "book_slot", missingConnectionKey: "connection-1" },
    ]);
  });
});
