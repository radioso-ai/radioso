import { describe, expect, it, vi } from "vitest";

import { AGENT_CONFIG_SCHEMA_VERSION } from "../../src/modules/agents/agentConfig.js";
import {
  AGENT_BUNDLE_SCHEMA_VERSION,
  AgentBundleImportService,
  projectAgentConfigForImport,
  type AgentBundle,
} from "../../src/modules/agentBundle/public.js";

const agentConfig = (over: Record<string, unknown> = {}): AgentBundle["agent"] => ({
  schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  portability: {},
  name: "Support Bot",
  customInstruction: "Be precise.",
  contactRequestsEnabled: true,
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  logo: null,
  theme: null,
  branding: null,
  greetingInstruction: "Hello.",
  assistantDefaultLocale: "en-US",
  proactiveGreetingEnabled: false,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: null,
      launcherPosition: "bottom-right",
      theme: null,
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  skillSettings: {},
  chatModelOverride: null,
  authoredDirectives: [],
  externalSkills: { connections: [], skills: [] },
  ...over,
} as unknown as AgentBundle["agent"]);

const bundle = (over: Partial<AgentBundle> = {}): AgentBundle => ({
  bundleVersion: AGENT_BUNDLE_SCHEMA_VERSION,
  portability: {},
  agent: agentConfig(),
  routines: [],
  contextVariables: [],
  agentSkills: [],
  ...over,
});

const harness = (over: {
  capabilities?: string[];
  variableIds?: Record<string, string>;
  skillIds?: Record<string, string>;
  publishRejects?: boolean;
  createDirectiveThrows?: boolean;
} = {}) => {
  const created: Array<{ agentId: string; skill: unknown }> = [];
  const createdSkillNames = new Set<string>();
  const directivesWritten: Array<{ name: string; enabled?: boolean }> = [];
  const writeOrder: string[] = [];
  const enabled: unknown[] = [];
  const drafts: Array<{ definition: unknown }> = [];
  const deleted: string[] = [];
  const capabilities = new Set(over.capabilities ?? ["webhook.call", "retrieve"]);

  const service = new AgentBundleImportService({
    agents: {
      create: async () => ({ agentId: "new-agent" }),
      delete: async (_workspaceId, agentId) => { deleted.push(agentId); },
    },
    directives: {
      create: async (_workspaceId, _agentId, directive) => {
        if (over.createDirectiveThrows) {
          throw new Error("directive rejected");
        }
        const typed = directive as { name: string; binding?: { skillName: string } | null; enabled?: boolean };
        // Mirrors AuthoredDirectiveService: a binding is validated against the
        // agent's skills, and a disabled directive skips that gate entirely.
        if (typed.binding && typed.enabled !== false && !createdSkillNames.has(typed.binding.skillName)) {
          throw new Error(`Directive binding references unknown skill "${typed.binding.skillName}"`);
        }
        writeOrder.push(`directive:${typed.name}`);
        directivesWritten.push(typed);
      },
    },
    skills: {
      hasCapability: (capability) => capabilities.has(capability),
      create: async (_workspaceId, agentId, skill) => {
        created.push({ agentId, skill });
        if (skill.enabled) {
          createdSkillNames.add(skill.name);
        }
        writeOrder.push(`skill:${skill.name}`);
      },
    },
    contextVariables: {
      findVariableIdByName: async (_workspaceId, name) => over.variableIds?.[name] ?? null,
      findSkillIdByName: async (_workspaceId, _agentId, name) => over.skillIds?.[name] ?? null,
      enable: async (_workspaceId, _agentId, enablement) => { enabled.push(enablement); },
    },
    routines: {
      createDraft: async (_workspaceId, _agentId, definition) => {
        drafts.push({ definition });
        return { routineId: `routine-${drafts.length}` };
      },
      publish: async () => (over.publishRejects
        ? { published: false as const, reason: "unknown skill: tool step references \"crm.create_lead\"" }
        : { published: true as const }),
    },
  });

  return { service, created, enabled, drafts, deleted, directivesWritten, writeOrder };
};

describe("AgentBundleImportService", () => {
  it("rejects a bundle written against a version it does not read", async () => {
    const { service } = harness();

    await expect(
      service.import("workspace-1", bundle({ bundleVersion: 2 as never })),
    ).rejects.toThrow(/Unsupported bundle version 2/);

    await expect(
      service.import("workspace-1", bundle({ agent: agentConfig({ schemaVersion: 99 }) })),
    ).rejects.toThrow(/Unsupported agent config version 99/);
  });

  it("still reads the previous agent config version, defaulting the fields it predates", async () => {
    const { service } = harness();

    // v3 predates internalName and handoffOnRetrievalMiss. Accepting it is explicit,
    // not incidental: both default to the behaviour a v3 agent actually had.
    const legacy = agentConfig({ schemaVersion: 3 }) as unknown as Record<string, unknown>;
    delete legacy.internalName;
    delete legacy.handoffOnRetrievalMiss;

    const result = await service.import("workspace-1", bundle({ agent: legacy as never }));

    expect(result.agentId).toBe("new-agent");
  });

  it("imports a skill whose connection did not travel as disabled, and says so", async () => {
    const { service, created } = harness();

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "crm.create_lead",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: "webhook_destination", id: { __ref: "agentSkillTarget" } },
      }],
    }));

    expect(created).toHaveLength(1);
    const { skill } = created[0] as unknown as { skill: { enabled: boolean; target: { id: unknown } } };
    expect(skill.enabled).toBe(false);
    expect(skill.target.id).toBeNull();
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_target_unbound",
      element: "skill:crm.create_lead",
    }));
  });

  it("fails the import when a skill cannot be created for a reason that is not its target", async () => {
    // A duplicate name, invalid config or unsupported invocation mode means this
    // deployment cannot build the bundle. Reporting it as an unbound target would
    // name the wrong cause and hand back an agent quietly missing behaviour.
    const deleted: string[] = [];
    const service = new AgentBundleImportService({
      agents: {
        create: async () => ({ agentId: "new-agent" }),
        delete: async (_workspaceId, agentId) => { deleted.push(agentId); },
      },
      directives: { create: async () => undefined },
      skills: {
        hasCapability: () => true,
        create: async () => { throw new Error('Skill name "crm.create_lead" is already in use'); },
      },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    await expect(
      service.import("workspace-1", bundle({
        agentSkills: [{
          name: "crm.create_lead",
          capability: "webhook.call",
          invocationMode: "routine_named",
          enabled: true,
          config: {},
          omittedConfigKeys: [],
          // No placeheld target: nothing about this failure is a missing connection.
          target: { kind: "webhook_destination", id: null },
        }],
      })),
    ).rejects.toThrow(/already in use/);

    expect(deleted).toEqual(["new-agent"]);
  });

  it("reports a skill whose placeheld target the workspace cannot supply, without failing the import", async () => {
    const service = new AgentBundleImportService({
      agents: { create: async () => ({ agentId: "new-agent" }), delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: {
        hasCapability: () => true,
        create: async () => { throw new Error("target is required for this capability"); },
      },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "crm.create_lead",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: "webhook_destination", id: { __ref: "agentSkillTarget" } },
      }],
    }));

    expect(result.agentId).toBe("new-agent");
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_target_unbound",
      element: "skill:crm.create_lead",
    }));
  });

  it("tells the operator which skill settings did not travel", async () => {
    const { service } = harness();

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "notify.ops",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: ["delivery.recipientEmails", "delivery.webhook.url"],
        target: { kind: "webhook_destination", id: null },
      }],
    }));

    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_config_not_portable",
      element: "skill:notify.ops",
      detail: expect.stringContaining("delivery.recipientEmails"),
    }));
  });

  it("skips a skill whose capability this deployment does not register", async () => {
    const { service, created } = harness({ capabilities: [] });

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "crm.create_lead",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: null, id: null },
      }],
    }));

    expect(created).toHaveLength(0);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_capability_unknown",
    }));
  });

  it("resolves a context variable by name and its resolver by skill name", async () => {
    const { service, enabled } = harness({
      variableIds: { plan_tier: "var-1" },
      skillIds: { "crm.lookup": "skill-1" },
    });

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "crm.lookup",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: null, id: null },
      }],
      contextVariables: [{
        variableName: "plan_tier",
        source: "resolver",
        resolverSkillName: "crm.lookup",
        maxAgeSeconds: 300,
        resolverTimeoutMs: 2000,
        surfacing: "on_reference",
        enabled: true,
      }],
    }));

    expect(enabled).toEqual([{
      variableId: "var-1",
      source: "resolver",
      resolverSkillId: "skill-1",
      maxAgeSeconds: 300,
      resolverTimeoutMs: 2000,
      surfacing: "on_reference",
      enabled: true,
    }]);
    expect(result.unresolved).toHaveLength(0);
  });

  it("reports a context variable the target workspace does not have, without writing it", async () => {
    const { service, enabled } = harness({ variableIds: {} });

    const result = await service.import("workspace-1", bundle({
      contextVariables: [{
        variableName: "plan_tier",
        source: "pushed",
        resolverSkillName: null,
        maxAgeSeconds: null,
        resolverTimeoutMs: null,
        surfacing: "always",
        enabled: true,
      }],
    }));

    expect(enabled).toHaveLength(0);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "context_variable_missing",
      element: "contextVariable:plan_tier",
    }));
  });

  it("keeps a routine that fails publish validation as a draft and reports it", async () => {
    const { service, drafts } = harness({ publishRejects: true });

    const result = await service.import("workspace-1", bundle({
      routines: [{
        name: "book-a-demo",
        version: 3,
        definition: { name: "book-a-demo" } as never,
      }],
    }));

    expect(drafts).toHaveLength(1);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "routine_invalid",
      element: "routine:book-a-demo",
    }));
  });

  it("creates skills before directives, because a directive binding names a skill", async () => {
    const { service, writeOrder, directivesWritten } = harness();

    const result = await service.import("workspace-1", bundle({
      agent: agentConfig({
        authoredDirectives: [{
          name: "refund-tone",
          action: "Offer the refund politely.",
          binding: { kind: "skill", skillName: "issue_refund" },
        }],
      }),
      agentSkills: [{
        name: "issue_refund",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: null, id: null },
      }],
    }));

    expect(writeOrder).toEqual(["skill:issue_refund", "directive:refund-tone"]);
    expect(directivesWritten).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
  });

  it("imports a directive whose binding cannot be satisfied as disabled, and says so", async () => {
    // The skill's capability is not registered here, so it is never created and the
    // binding has nothing to resolve against.
    const { service, directivesWritten } = harness({ capabilities: [] });

    const result = await service.import("workspace-1", bundle({
      agent: agentConfig({
        authoredDirectives: [{
          name: "refund-tone",
          action: "Offer the refund politely.",
          binding: { kind: "skill", skillName: "issue_refund" },
        }],
      }),
      agentSkills: [{
        name: "issue_refund",
        capability: "webhook.call",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: [],
        target: { kind: null, id: null },
      }],
    }));

    // The authored text survives; it just cannot fire until the operator rebinds it.
    expect(directivesWritten).toEqual([expect.objectContaining({
      name: "refund-tone",
      enabled: false,
    })]);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "directive_binding_unbound",
      element: "directive:refund-tone",
    }));
  });

  it("names the orphan when compensation itself fails, because nothing else will", async () => {
    const logged: Array<{ level: string; payload: Record<string, unknown> }> = [];
    const logger = {
      error: (payload: Record<string, unknown>) => { logged.push({ level: "error", payload }) },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };

    const service = new AgentBundleImportService({
      logger: logger as never,
      agents: {
        create: async () => ({ agentId: "new-agent" }),
        delete: async () => { throw new Error("connection reset"); },
      },
      directives: { create: async () => { throw new Error("directive rejected"); } },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    await expect(
      service.import("workspace-1", bundle({
        agent: agentConfig({ authoredDirectives: [{ name: "tone", action: "Be brief." }] }),
      })),
    ).rejects.toThrow(/directive rejected/);

    // The original failure still surfaces to the caller; the compensation failure
    // is the one that would otherwise vanish, leaving a half-built agent nobody
    // can trace back to an import.
    expect(logged).toHaveLength(1);
    expect(logged[0].payload).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      orphanedAgentId: "new-agent",
    }));
  });

  it("deletes the agent it created when a later step fails", async () => {
    const { service, deleted } = harness({ createDirectiveThrows: true });

    await expect(
      service.import("workspace-1", bundle({
        agent: agentConfig({ authoredDirectives: [{ name: "tone", action: "Be brief." }] }),
      })),
    ).rejects.toThrow(/directive rejected/);

    expect(deleted).toEqual(["new-agent"]);
  });

  it("never widens document scope: unresolvable selected sources import as none", async () => {
    const create = vi.fn(async (_workspaceId: string, _input: unknown) => ({ agentId: "new-agent" }));
    const service = new AgentBundleImportService({
      agents: { create, delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    const result = await service.import("workspace-1", bundle({
      agent: agentConfig({
        skillSettings: {
          "retrieval.answer": {
            enabled: true,
            settings: {
              __agentRetrievalDefaults: {
                sourceScope: {
                  mode: "selected",
                  sourceIds: [{ __ref: "documentSource" }, { __ref: "documentSource" }],
                },
                suggestedQuestionsEnabled: true,
                citationDisplayEnabled: true,
                assistantLinkUtmEnabled: false,
              },
            },
          },
        },
      }),
    }));

    const input = create.mock.calls[0]?.[1] as unknown as { sourceScope: unknown };
    expect(input.sourceScope).toEqual({ mode: "selected", sourceIds: [] });
    expect(JSON.stringify(input)).not.toContain("__ref");
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "document_source_unresolved",
    }));
  });

  it("keeps the portable half of an array entry that carries one unportable field", async () => {
    const { input } = projectAgentConfigForImport(agentConfig({
      surfaceSettings: {
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: {
          enabled: false,
          token: null,
          allowedOrigins: [],
          launcherLabel: null,
          launcherPosition: "bottom-right",
          theme: null,
          copy: {},
          expertOverrides: {},
        },
        extensions: {
          // An extension surface shaped as a list of objects, each mixing an
          // authored value with a credential. Dropping whole entries would lose the
          // authored half for the sake of the redacted one.
          kiosk: [
            { label: "Lobby", token: { __redacted: "secret" } },
            { label: "Reception" },
          ],
        },
      },
    }) as never) as unknown as { input: { surfaceSettings: { extensions: { kiosk: Array<Record<string, unknown>> } } } };

    expect(input.surfaceSettings.extensions.kiosk).toEqual([
      { label: "Lobby" },
      { label: "Reception" },
    ]);
    expect(JSON.stringify(input)).not.toContain("__redacted");
  });

  it("imports a token-bearing surface disabled rather than minting a new credential", async () => {
    const create = vi.fn(async (_workspaceId: string, _input: unknown) => ({ agentId: "new-agent" }));
    const service = new AgentBundleImportService({
      agents: { create, delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    const result = await service.import("workspace-1", bundle({
      agent: agentConfig({
        surfaceSettings: {
          authenticatedChat: { enabled: true },
          anonymousChat: { enabled: true, token: { __redacted: "secret" } },
          websiteEmbed: {
            enabled: true,
            token: { __redacted: "secret" },
            allowedOrigins: [{ __ref: "websiteEmbedAllowedOrigin" }],
            launcherLabel: "Ask us",
            launcherPosition: "bottom-right",
            theme: null,
            copy: {},
            expertOverrides: {},
          },
          extensions: {},
        },
      }),
    }));

    const input = create.mock.calls[0]?.[1] as unknown as {
      surfaceSettings: {
        anonymousChat: { enabled: boolean };
        websiteEmbed: { enabled: boolean; allowedOrigins: unknown[]; launcherLabel: string };
      };
    };
    expect(input.surfaceSettings.anonymousChat.enabled).toBe(false);
    expect(input.surfaceSettings.websiteEmbed.enabled).toBe(false);
    expect(input.surfaceSettings.websiteEmbed.allowedOrigins).toEqual([]);
    // Non-credential embed settings still travel.
    expect(input.surfaceSettings.websiteEmbed.launcherLabel).toBe("Ask us");
    expect(result.unresolved.filter((entry) => entry.kind === "surface_credential_unbound")).toHaveLength(2);
  });

  it("reports a skill whose non-portable config was stripped, without failing the bundle", async () => {
    // A notify skill has no target, so `targetDidNotTravel` is false and the create
    // rejection below used to be treated as "this deployment cannot build the
    // bundle" and abort the whole import. But the export is what emptied the config,
    // and it said so in omittedConfigKeys: a failure the export caused is one the
    // import expects and can explain, not a reason to refuse the agent.
    const deleted: string[] = [];
    const service = new AgentBundleImportService({
      agents: {
        create: async () => ({ agentId: "new-agent" }),
        delete: async (_workspaceId, agentId) => { deleted.push(agentId); },
      },
      directives: { create: async () => undefined },
      skills: {
        hasCapability: () => true,
        create: async () => { throw new Error("Invalid skill config"); },
      },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: {
        createDraft: async () => ({ routineId: "r1" }),
        publish: async () => ({ published: true as const }),
      },
    });

    const result = await service.import("workspace-1", bundle({
      agentSkills: [{
        name: "notify.ops",
        capability: "notify",
        invocationMode: "routine_named",
        enabled: true,
        config: {},
        omittedConfigKeys: ["delivery.recipientEmails", "delivery.webhook.url"],
        target: { kind: "notify_delivery", id: null },
      }],
    }));

    expect(deleted).toEqual([]);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_config_not_portable",
      element: "skill:notify.ops",
    }));
  });

  it("rejects a bundle whose agent config is missing a section the import must read", async () => {
    // The transport schema checks that a body is a bundle, not what a bundle
    // contains, so a body this shallow reaches the service. Dereferencing it
    // would be an unhandled TypeError — a 500 for what is a malformed request.
    const { service } = harness();

    await expect(
      service.import("workspace-1", bundle({
        agent: { schemaVersion: AGENT_CONFIG_SCHEMA_VERSION } as never,
      })),
    ).rejects.toMatchObject({ statusCode: 400, code: "bad_request" });
  });
});
