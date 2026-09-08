import { describe, expect, it } from "vitest";

import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import { AGENT_CONFIG_SCHEMA_VERSION } from "../../src/modules/agents/agentConfig.js";
import {
  AGENT_BUNDLE_SCHEMA_VERSION,
  AgentBundleExportService,
} from "../../src/modules/agentBundle/public.js";
import type {
  AgentBundleAgentSkillRecord,
  AgentBundleContextVariableRecord,
} from "../../src/modules/agentBundle/ports.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import { notifyCapability } from "../../src/modules/skills/capabilities/notify.js";

const baseAgent = (): ConversationAgent => ({
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
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true,
  logo: null,
  theme: { brand: "#112233", brandText: "#ffffff", surface: "#f8fafc", text: "#101820" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  greetingInstruction: "Welcome the visitor.",
  assistantDefaultLocale: "en-US",
  proactiveGreetingEnabled: false,
  sourceScope: { mode: "all" },
  skillSettings: {},
  chatModelOverride: null,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Ask us",
      launcherPosition: "bottom-right",
      theme: { brand: "#445566", brandText: "#ffffff", surface: "#ffffff", text: "#111111" },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  authoredDirectives: [],
});

const publishedRoutine = (over: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "routine-1",
  agentId: "agent-1",
  lineageId: "lineage-1",
  version: 2,
  status: "published",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  name: "book-a-demo",
  activation: {
    triggerDescription: "When the visitor asks to book a demo",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [],
  steps: [{
    stableStepId: "step_create_lead",
    kind: "tool",
    toolRef: "crm.create_lead",
    ordinal: 0,
    instruction: "Create the lead.",
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_create_lead",
    toRef: "terminal_complete",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: "Confirm the demo booking.",
    ordinal: 1,
  }],
  ...over,
});

const service = (over: {
  routines?: RoutineDefinition[];
  contextVariables?: AgentBundleContextVariableRecord[];
  agentSkills?: AgentBundleAgentSkillRecord[];
} = {}) => new AgentBundleExportService({
  agents: { load: async () => baseAgent() },
  externalSkills: { load: async () => null },
  routines: { listByAgent: async () => over.routines ?? [] },
  contextVariables: { listByAgent: async () => over.contextVariables ?? [] },
  agentSkills: { listByAgent: async () => over.agentSkills ?? [] },
  skillConfigPortability: {
    portableFieldKeys: () => new Set<string>(),
    settingsFieldKeys: () => new Set<string>(),
  },
});

describe("AgentBundleExportService", () => {
  it("reports config a capability never declared, instead of dropping it unseen", async () => {
    // `email` declares only `mode` in settingsFields, but its config schema also
    // carries boundInputs/exposedInputs — real authored field routing. A key nobody
    // declared is a key nobody judged safe, so it must not travel, and it must not
    // vanish without a word either.
    const bundle = await new AgentBundleExportService({
      agents: { load: async () => baseAgent() },
      externalSkills: { load: async () => null },
      routines: { listByAgent: async () => [] },
      contextVariables: { listByAgent: async () => [] },
      agentSkills: {
        listByAgent: async () => [{
          name: "customer.email",
          capability: "email",
          invocationMode: "routine_named",
          enabled: true,
          config: {
            mode: "send",
            boundInputs: { to: "$customer.email", subject: "Your order" },
            exposedInputs: { bodyHtml: { description: "Body" } },
          },
          target: { kind: null, id: null },
        }],
      },
      skillConfigPortability: {
        portableFieldKeys: () => new Set(["mode"]),
        settingsFieldKeys: () => new Set(["mode"]),
      },
    }).export("workspace-1", "agent-1");

    const [skill] = bundle.agentSkills;
    expect(skill.config).toEqual({ mode: "send" });
    expect(skill.omittedConfigKeys).toEqual(["boundInputs", "exposedInputs"]);
    expect(JSON.stringify(bundle)).not.toContain("$customer.email");
    expect(JSON.stringify(bundle)).not.toContain("Your order");
  });

  it("wraps the agent config without changing its schema version", async () => {
    const bundle = await service().export("workspace-1", "agent-1");

    expect(bundle.bundleVersion).toBe(AGENT_BUNDLE_SCHEMA_VERSION);
    expect(bundle.agent.schemaVersion).toBe(AGENT_CONFIG_SCHEMA_VERSION);
    expect(bundle.agent.name).toBe("Support Bot");
  });

  it("exports only published routines, stripped of workspace-scoped identity", async () => {
    const bundle = await service({
      routines: [
        publishedRoutine(),
        publishedRoutine({ id: "routine-2", status: "draft", name: "draft-only" }),
        publishedRoutine({ id: "routine-3", status: "archived", name: "retired" }),
        publishedRoutine({ id: "routine-4", status: "superseded", name: "book-a-demo", version: 1 }),
      ],
    }).export("workspace-1", "agent-1");

    expect(bundle.routines).toHaveLength(1);
    const [routine] = bundle.routines;
    expect(routine.name).toBe("book-a-demo");
    expect(routine.version).toBe(2);
    expect(routine.definition).not.toHaveProperty("id");
    expect(routine.definition).not.toHaveProperty("agentId");
    expect(routine.definition).not.toHaveProperty("lineageId");
    expect(routine.definition).not.toHaveProperty("status");
    // A routine names its skill; it never carries the skill's id.
    expect(routine.definition.steps[0].toolRef).toBe("crm.create_lead");
  });

  it("never carries the contact-request destination out of the workspace", async () => {
    const agent = baseAgent();
    agent.contactRequestsEnabled = true;
    agent.contactRequestDelivery = {
      recipientEmails: ["oncall@acme.example"],
      webhook: { url: "https://hooks.acme.example/contact?token=abc123" },
    };

    const bundle = await new AgentBundleExportService({
      agents: { load: async () => agent },
      externalSkills: { load: async () => null },
      routines: { listByAgent: async () => [] },
      contextVariables: { listByAgent: async () => [] },
      agentSkills: { listByAgent: async () => [] },
      skillConfigPortability: {
        portableFieldKeys: () => new Set<string>(),
        settingsFieldKeys: () => new Set<string>(),
      },
    }).export("workspace-1", "agent-1");

    expect(bundle.agent.contactRequestDelivery).toEqual({ __redacted: "secret" });
    expect(bundle.agent.portability.contactRequestDelivery).toBe("secret");
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("oncall@acme.example");
    expect(serialized).not.toContain("hooks.acme.example");
    expect(serialized).not.toContain("abc123");
  });

  it("re-keys context-variable enablements to natural keys", async () => {
    const bundle = await service({
      contextVariables: [{
        variableId: "11111111-1111-1111-1111-111111111111",
        variableName: "plan_tier",
        source: "resolver",
        resolverSkillId: "22222222-2222-2222-2222-222222222222",
        resolverSkillName: "crm.lookup",
        maxAgeSeconds: 300,
        resolverTimeoutMs: 2000,
        surfacing: "on_reference",
        enabled: true,
      }],
    }).export("workspace-1", "agent-1");

    expect(bundle.contextVariables).toEqual([{
      variableName: "plan_tier",
      source: "resolver",
      resolverSkillName: "crm.lookup",
      maxAgeSeconds: 300,
      resolverTimeoutMs: 2000,
      surfacing: "on_reference",
      enabled: true,
    }]);
    expect(JSON.stringify(bundle.contextVariables)).not.toContain("11111111");
    expect(JSON.stringify(bundle.contextVariables)).not.toContain("22222222");
  });

  it("placeholds a skill's connection target instead of emitting the id", async () => {
    const bundle = await service({
      agentSkills: [{
        name: "crm.create_lead",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        target: { kind: "webhook_destination", id: "33333333-3333-3333-3333-333333333333" },
      }],
    }).export("workspace-1", "agent-1");

    const [skill] = bundle.agentSkills;
    expect(skill.target.kind).toBe("webhook_destination");
    expect(skill.target.id).toEqual({ __ref: "agentSkillTarget" });
    expect(JSON.stringify(bundle)).not.toContain("33333333");
    expect(bundle.portability["agentSkills[].target.id"]).toBe("ref");
  });

  it("omits skill config values the capability has not marked portable", async () => {
    const bundle = await new AgentBundleExportService({
      agents: { load: async () => baseAgent() },
      externalSkills: { load: async () => null },
      routines: { listByAgent: async () => [] },
      contextVariables: { listByAgent: async () => [] },
      agentSkills: {
        listByAgent: async () => [{
          name: "notify.ops",
          capability: "notify",
          invocationMode: "routine_named",
          enabled: true,
          config: {
            delivery: {
              recipientEmails: ["oncall@example.com"],
              webhook: { url: "https://hooks.example.com/secret" },
            },
            tone: "urgent",
          },
          target: { kind: null, id: null },
        }],
      },
      skillConfigPortability: {
        portableFieldKeys: () => new Set(["tone"]),
        settingsFieldKeys: () => new Set(["tone", "delivery.recipientEmails", "delivery.webhook.url"]),
      },
    }).export("workspace-1", "agent-1");

    const [skill] = bundle.agentSkills;
    expect(skill.config).toEqual({ tone: "urgent" });
    expect(JSON.stringify(bundle)).not.toContain("oncall@example.com");
    expect(JSON.stringify(bundle)).not.toContain("hooks.example.com");
    // Names travel so import can say what to re-enter; values do not.
    expect(skill.omittedConfigKeys).toEqual(["delivery.recipientEmails", "delivery.webhook.url"]);
  });

  it("exports a notify skill as a config its own capability still accepts", async () => {
    // Every notify settings field is non-portable (a webhook URL carries a signed
    // token, recipient emails are personal data), so export strips all of them. The
    // stripped shape still has to satisfy `validateConfig`, because import creates
    // the skill from exactly this object — a config only the source workspace could
    // validate is a bundle that cannot be imported anywhere.
    const record: AgentBundleAgentSkillRecord = {
      name: "notify.ops",
      capability: "notify",
      invocationMode: "routine_named",
      enabled: true,
      config: {
        delivery: { recipientEmails: ["ops@example.com"], webhook: { url: "https://hooks.example.com/x" } },
        exposedInputs: { message: true },
      },
      target: { kind: "notify_delivery", id: null },
    };

    const bundle = await new AgentBundleExportService({
      agents: { load: async () => baseAgent() },
      externalSkills: { load: async () => null },
      routines: { listByAgent: async () => [] },
      contextVariables: { listByAgent: async () => [] },
      agentSkills: { listByAgent: async () => [record] },
      skillConfigPortability: {
        // The real descriptor: nothing here is portable, and that is the point.
        portableFieldKeys: () => new Set<string>(),
        settingsFieldKeys: () => new Set(notifyCapability.settingsFields.map((field) => field.key)),
      },
    }).export("workspace-1", "agent-1");

    const [skill] = bundle.agentSkills;
    expect(skill.omittedConfigKeys).toEqual(expect.arrayContaining([
      "delivery.recipientEmails",
      "delivery.webhook.url",
    ]));
    expect(notifyCapability.validateConfig(skill.config).success).toBe(true);
  });
});
