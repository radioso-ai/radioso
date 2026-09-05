import { describe, expect, it, vi } from "vitest";

import { AGENT_CONFIG_SCHEMA_VERSION } from "../../src/modules/agents/agentConfig.js";
import {
  AGENT_BUNDLE_SCHEMA_VERSION,
  AgentBundleImportService,
  type AgentBundle,
} from "../../src/modules/agentBundle/public.js";

const bundle = (): AgentBundle => ({
  bundleVersion: AGENT_BUNDLE_SCHEMA_VERSION,
  portability: {},
  agent: {
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    portability: {},
    name: "Support",
    customInstruction: "Be precise.",
    contactRequestsEnabled: false,
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
      websiteEmbed: { enabled: false, token: null, allowedOrigins: [], launcherLabel: null, launcherPosition: "bottom-right", theme: null, copy: {}, expertOverrides: {} },
      extensions: {},
    },
    skillSettings: {},
    chatModelOverride: null,
    authoredDirectives: [],
    externalSkills: { connections: [], skills: [] },
  } as never,
  routines: [],
  contextVariables: [],
  agentSkills: [],
});

describe("AgentBundleImportService import jobs", () => {
  it("persists and completes a job around a successful import", async () => {
    const imports = {
      createOrGet: vi.fn(async () => ({ status: "created", job: { id: "import-1" } })),
      markApplying: vi.fn(async () => undefined),
      setCreatedAgent: vi.fn(async () => undefined),
      markApplied: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const service = new AgentBundleImportService({
      imports: imports as never,
      agents: { create: async () => ({ agentId: "agent-1" }), delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: {
        findVariableIdByName: async () => null,
        findSkillIdByName: async () => null,
        enable: async () => undefined,
      },
      routines: { createDraft: async () => ({ routineId: "routine-1" }), publish: async () => ({ published: true as const }) },
    } as never);

    const result = await service.import({ workspaceId: "workspace-1", actorAccountId: "account-1", idempotencyKey: "import-1", bundle: bundle() });

    expect(result).toMatchObject({ agentId: "agent-1", importId: "import-1" });
    expect(imports.createOrGet).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      actorAccountId: "account-1",
      idempotencyKey: "import-1",
    }));
    expect(imports.markApplying).toHaveBeenCalledWith("import-1");
    expect(imports.setCreatedAgent).toHaveBeenCalledWith("import-1", "agent-1");
    expect(imports.markApplied).toHaveBeenCalledWith("import-1", expect.objectContaining({ agentId: "agent-1" }));
  });

  it("returns an applied result for a duplicate key without creating another agent", async () => {
    const create = vi.fn(async () => ({ agentId: "agent-new" }));
    const service = new AgentBundleImportService({
      imports: {
        createOrGet: async () => ({
          status: "existing",
          job: { id: "import-1", state: "applied", agentId: "agent-existing", unresolved: [] },
        }),
      } as never,
      agents: { create, delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: { findVariableIdByName: async () => null, findSkillIdByName: async () => null, enable: async () => undefined },
      routines: { createDraft: async () => ({ routineId: "routine-1" }), publish: async () => ({ published: true as const }) },
    } as never);

    await expect(service.import({ workspaceId: "workspace-1", actorAccountId: "account-1", idempotencyKey: "same-key", bundle: bundle() }))
      .resolves.toMatchObject({ importId: "import-1", agentId: "agent-existing" });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a stable conflict while another request owns the same key", async () => {
    const service = new AgentBundleImportService({
      imports: { createOrGet: async () => ({ status: "existing", job: { id: "import-1", state: "applying", agentId: null, unresolved: [] } }) } as never,
      agents: { create: async () => ({ agentId: "agent-new" }), delete: async () => undefined },
      directives: { create: async () => undefined },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: { findVariableIdByName: async () => null, findSkillIdByName: async () => null, enable: async () => undefined },
      routines: { createDraft: async () => ({ routineId: "routine-1" }), publish: async () => ({ published: true as const }) },
    } as never);

    await expect(service.import({ workspaceId: "workspace-1", actorAccountId: "account-1", idempotencyKey: "same-key", bundle: bundle() }))
      .rejects.toMatchObject({ statusCode: 409, code: "agent_bundle_import_in_progress", details: { importId: "import-1" } });
  });

  it("leaves a failed compensation job applying so the sweep can reclaim it", async () => {
    const imports = {
      createOrGet: async () => ({ status: "created", job: { id: "import-1" } }),
      markApplying: async () => undefined,
      setCreatedAgent: async () => undefined,
      markFailed: vi.fn(async () => undefined),
    };
    const service = new AgentBundleImportService({
      imports: imports as never,
      agents: { create: async () => ({ agentId: "agent-1" }), delete: async () => { throw new Error("network"); } },
      directives: { create: async () => { throw new Error("invalid directive"); } },
      skills: { hasCapability: () => true, create: async () => undefined },
      contextVariables: { findVariableIdByName: async () => null, findSkillIdByName: async () => null, enable: async () => undefined },
      routines: { createDraft: async () => ({ routineId: "routine-1" }), publish: async () => ({ published: true as const }) },
    } as never);

    const invalidDirectiveBundle = bundle();
    (invalidDirectiveBundle.agent as unknown as { authoredDirectives: unknown[] }).authoredDirectives = [{ name: "", action: "" }];
    await expect(service.import({ workspaceId: "workspace-1", actorAccountId: "account-1", bundle: invalidDirectiveBundle })).rejects.toThrow("invalid directive");
    expect(imports.markFailed).toHaveBeenCalledWith("import-1", "apply_failed", { terminal: false });
  });
});
