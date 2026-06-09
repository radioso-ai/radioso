import { describe, expect, it, vi } from "vitest";

import { createDefaultAgentSkillSettingsRegistry } from "../../src/app/composition/skillSettingsResolver.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../src/modules/documents/contracts/index.js";
import {
  AgentSurfaceExtensionRegistry,
  defaultAgentEmbedTheme,
  getWebsiteEmbedSurfaceSettings,
  type WebsiteEmbedSurfaceSettings,
} from "../../src/modules/agents/public.js";

const websiteEmbedDefaults = (): WebsiteEmbedSurfaceSettings => ({
  enabled: false,
  token: null,
  allowedOrigins: [],
  launcherLabel: "Chat with us",
  launcherPosition: "bottom-right",
  theme: defaultAgentEmbedTheme(),
  copy: {},
  expertOverrides: {},
});

const agentRow = (outputModes: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Support",
  retrieval_enabled: true,
  source_scope_mode: "all",
  source_ids: [],
  behavior_settings: {},
  greeting_settings: {},
  output_modes: outputModes,
  skill_settings: {},
  authored_directives: [],
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const directiveRow = (overrides: Record<string, unknown> = {}) => ({
  id: "directive-1",
  agent_id: "agent-1",
  name: "formal-register",
  condition_kind: "always",
  condition_description: null,
  action: "Use a formal register.",
  priority: null,
  required_capabilities: [],
  depends_on: [],
  excludes: [],
  routes: ["retrieval"],
  scope_tags: [],
  description: null,
  metadata: {},
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const repositoryWithRow = (row: ReturnType<typeof agentRow>, registry: AgentSurfaceExtensionRegistry) =>
  new AgentRepository({
    queryOptional: async () => row,
  } as never, registry);

describe("AgentRepository", () => {
  it("defaults assistant link UTM attribution on when stored behavior predates the setting", async () => {
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }),
    } as never);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.assistantLinkUtmEnabled).toBe(true);
  });

  it("defaults contact request delivery when stored behavior predates the setting", async () => {
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }),
    } as never);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.contactRequestDelivery).toEqual({
      recipientEmails: [],
      webhook: null,
    });
  });

  it("persists contact request delivery in behavior settings", async () => {
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("INSERT INTO agents")) {
        return {
          rows: [
            agentRow({
              authenticatedChat: { enabled: true },
              anonymousChat: { enabled: false, token: null },
              websiteEmbed: websiteEmbedDefaults(),
            }, {
              behavior_settings: {
                contactRequestDelivery: {
                  recipientEmails: ["sales@example.com"],
                  webhook: { url: "https://hooks.example.com/contact" },
                },
              },
            }),
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new AgentRepository({
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    await repository.create("workspace-1", {
      name: "Support",
      contactRequestDelivery: {
        recipientEmails: ["sales@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
    });

    const insertParams = query.mock.calls[0]?.[1] as unknown[] | undefined;
    expect(JSON.parse(insertParams?.[5] as string)).toMatchObject({
      contactRequestDelivery: {
        recipientEmails: ["sales@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
    });
  });

  it("parses registered surface extension data on read before mapping website embed settings", async () => {
    const parsedWebsiteEmbed: WebsiteEmbedSurfaceSettings = {
      ...websiteEmbedDefaults(),
      enabled: true,
      token: "extension-token",
      allowedOrigins: ["https://docs.example.com"],
      launcherLabel: "Ask docs",
    };
    const parse = vi.fn(() => parsedWebsiteEmbed);
    const registry = new AgentSurfaceExtensionRegistry();
    registry.register({
      key: "websiteEmbed",
      defaults: websiteEmbedDefaults,
      normalize: (value: unknown) => value,
      serialize: (value: unknown) => value,
      parse,
    });
    const repository = repositoryWithRow(agentRow({
      authenticatedChat: { enabled: true },
      anonymousChat: { enabled: false, token: null },
      websiteEmbed: {
        ...websiteEmbedDefaults(),
        enabled: true,
        token: "legacy-token",
        allowedOrigins: ["https://legacy.example.com"],
        launcherLabel: "Legacy",
      },
      extensions: {
        websiteEmbed: { enabled: true, token: "extension-token" },
      },
    }), registry);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(parse).toHaveBeenCalledWith({ enabled: true, token: "extension-token" });
    expect(agent).not.toBeNull();
    expect(getWebsiteEmbedSurfaceSettings(agent!)).toEqual(parsedWebsiteEmbed);
  });

  it("falls back to extension defaults when stored extension data is malformed", async () => {
    const registry = new AgentSurfaceExtensionRegistry();
    registry.register({
      key: "websiteEmbed",
      defaults: websiteEmbedDefaults,
      normalize: (value: unknown) => value,
      serialize: (value: unknown) => value,
      parse: () => {
        throw new Error("websiteEmbed extension data is invalid");
      },
    });
    const repository = repositoryWithRow(agentRow({
      authenticatedChat: { enabled: true },
      anonymousChat: { enabled: false, token: null },
      websiteEmbed: {
        ...websiteEmbedDefaults(),
        enabled: true,
        token: "legacy-token",
        allowedOrigins: ["https://legacy.example.com"],
      },
      extensions: {
        websiteEmbed: "not-a-settings-object",
      },
    }), registry);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent).not.toBeNull();
    expect(getWebsiteEmbedSurfaceSettings(agent!)).toEqual(websiteEmbedDefaults());
  });

  it("rehydrates the manual documents sentinel from the stored unassigned source filter", async () => {
    const realSourceId = "11111111-1111-1111-1111-111111111111";
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, {
        source_scope_mode: "selected",
        source_ids: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, realSourceId],
      }),
    } as never);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, realSourceId],
    });
  });

  it("maps skill_settings from storage onto the agent record", async () => {
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, {
        skill_settings: {
          "retrieval.answer": {
            vectorTopK: 7,
          },
          "custom.skill": {
            passthrough: true,
          },
        },
      }),
    } as never);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": {
        vectorTopK: 7,
      },
      "custom.skill": {
        passthrough: true,
      },
    });
  });

  it("loads persisted retrieval skill settings with unknown future fields", async () => {
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, {
        skill_settings: {
          "retrieval.answer": {
            vectorTopK: 7,
            futureField: "ignored on read",
          },
        },
      }),
    } as never, undefined, createDefaultAgentSkillSettingsRegistry());

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": {
        vectorTopK: 7,
      },
    });
  });

  it("loads persisted retrieval skill settings by dropping invalid fields and keeping valid fields", async () => {
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, {
        skill_settings: {
          "retrieval.answer": {
            queryRewriteEnabled: false,
            vectorTopK: 0,
            rerankTopK: 6,
          },
        },
      }),
    } as never, undefined, createDefaultAgentSkillSettingsRegistry());

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(agent?.skillSettings).toEqual({
      "retrieval.answer": {
        queryRewriteEnabled: false,
        rerankTopK: 6,
      },
    });
  });

  it("stores manual document selection as an unassigned source filter", async () => {
    const realSourceId = "11111111-1111-1111-1111-111111111111";
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("INSERT INTO agents")) {
        return {
          rows: [
            agentRow({
              authenticatedChat: { enabled: true },
              anonymousChat: { enabled: false, token: null },
              websiteEmbed: websiteEmbedDefaults(),
            }, {
              source_scope_mode: "selected",
              source_ids: [],
            }),
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new AgentRepository({
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    await repository.create("workspace-1", {
      name: "Manual scoped",
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 7,
        },
      },
      sourceScope: {
        mode: "selected",
        sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, realSourceId],
      },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO agents"),
      expect.arrayContaining([JSON.stringify({
        "retrieval.answer": {
          vectorTopK: 7,
        },
      })]),
    );
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("skill_settings"),
      expect.not.arrayContaining([MANUALLY_ADDED_DOCUMENTS_SOURCE_ID]),
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO agent_document_sources"),
      [expect.any(String), [null, realSourceId]],
    );
  });

  it("creates authored directives without touching agent settings blobs", async () => {
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("INSERT INTO agent_directives")) {
        return {
          rows: [directiveRow()],
        };
      }
      return { rows: [{ id: "agent-1" }] };
    });
    const repository = new AgentRepository({
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    await repository.createDirective("agent-1", "workspace-1", {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    });

    const insertCall = query.mock.calls.find(([text]) => text.includes("INSERT INTO agent_directives"));
    expect(insertCall?.[0]).toContain("INSERT INTO agent_directives");
    expect(insertCall?.[0]).toContain("name");
    expect(insertCall?.[0]).toContain("condition_kind");
    expect(insertCall?.[0]).toContain("required_capabilities");
    expect(insertCall?.[0]).not.toMatch(/behavior_settings|skill_settings|greeting_settings|output_modes/);
    expect(insertCall?.[1]).not.toContain("medium");
  });

  it("reports duplicate directive creates as conflicts", async () => {
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("INSERT INTO agent_directives")) {
        throw {
          code: "23505",
          constraint: "agent_directives_agent_id_name_key",
        };
      }
      return { rows: [{ id: "agent-1" }] };
    });
    const repository = new AgentRepository({
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    await expect(repository.createDirective("agent-1", "workspace-1", {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "formal-register" already exists for this agent.',
    } as Partial<AppError>);
  });

  it("reports duplicate directive renames as conflicts", async () => {
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("SELECT agent_directives")) {
        return [directiveRow()];
      }
      if (text.includes("UPDATE agent_directives")) {
        throw {
          code: "23505",
          constraint: "agent_directives_agent_id_name_key",
        };
      }
      return [];
    });
    const repository = new AgentRepository({ query } as never);

    await expect(repository.updateDirective("agent-1", "workspace-1", "directive-1", {
      name: "handoff-tone",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "handoff-tone" already exists for this agent.',
    } as Partial<AppError>);
  });

  it("loads authored directives in the single agent query and maps them onto the agent record", async () => {
    const queryOptional = vi.fn(async (_text: string, _params?: unknown[]) =>
      agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, {
        authored_directives: [{
          id: "directive-1",
          name: "formal-register",
          conditionKind: "contextual",
          conditionDescription: "When answering procurement questions",
          action: "Use a formal register.",
          priority: 50,
          requiredCapabilities: ["retrieval.answer"],
          dependsOn: [],
          excludes: [],
          routes: ["retrieval"],
          tags: ["step:contact:ask_email"],
          description: "Tone control",
          metadata: { source: "test" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }],
      }));
    const repository = new AgentRepository({ queryOptional } as never);

    const agent = await repository.findByIdAndWorkspaceId("agent-1", "workspace-1");

    expect(queryOptional.mock.calls[0]?.[0]).toContain("json_agg");
    expect(queryOptional.mock.calls[0]?.[0]).toContain("agent_directives");
    expect(agent?.authoredDirectives).toEqual([{
      id: "directive-1",
      agentId: "agent-1",
      name: "formal-register",
      condition: {
        kind: "contextual",
        description: "When answering procurement questions",
      },
      action: "Use a formal register.",
      priority: 50,
      requiredCapabilities: ["retrieval.answer"],
      dependsOn: [],
      excludes: [],
      routes: ["retrieval"],
      tags: ["step:contact:ask_email"],
      description: "Tone control",
      metadata: { source: "test" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    }]);
  });

  it("persists and reads directive scope tags through create, list, and update", async () => {
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes("SELECT agent_directives")) {
        return [directiveRow({ scope_tags: ["step:contact:ask_email"] })];
      }
      if (text.includes("INSERT INTO agent_directives")) {
        return { rows: [directiveRow({ scope_tags: params?.[10] })] };
      }
      if (text.includes("UPDATE agent_directives")) {
        return [directiveRow({ scope_tags: params?.[11] })];
      }
      return [];
    });
    const repository = new AgentRepository({
      query,
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    const created = await repository.createDirective("agent-1", "workspace-1", {
      name: "step scoped",
      condition: { kind: "always" },
      action: "Only while collecting email.",
      tags: ["step:contact:ask_email"],
    });
    const listed = await repository.listDirectives("agent-1", "workspace-1");
    const updated = await repository.updateDirective("agent-1", "workspace-1", "directive-1", {
      tags: ["routine:contact"],
    });

    expect(created.tags).toEqual(["step:contact:ask_email"]);
    expect(listed[0]?.tags).toEqual(["step:contact:ask_email"]);
    expect(updated.tags).toEqual(["routine:contact"]);
    expect(query.mock.calls.find(([text]) => text.includes("INSERT INTO agent_directives"))?.[0]).toContain("scope_tags");
    expect(query.mock.calls.find(([text]) => text.includes("UPDATE agent_directives"))?.[0]).toContain("scope_tags");
  });

  it("uses an updated_at compare-and-set guard on update and reports stale writes as conflicts", async () => {
    const currentUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes("UPDATE agents")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const repository = new AgentRepository({
      queryOptional: async () => agentRow({
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false, token: null },
        websiteEmbed: websiteEmbedDefaults(),
      }, { updated_at: currentUpdatedAt }),
      withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    } as never);

    await expect(repository.update("agent-1", "workspace-1", {
      name: "Support stale",
    }, { expectedUpdatedAt: currentUpdatedAt })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    } as Partial<AppError>);

    const updateSql = query.mock.calls.find(([text]) => text.includes("UPDATE agents"))?.[0];
    expect(updateSql).toContain("date_trunc('milliseconds', updated_at)");
    expect(updateSql).toMatch(/WHERE id = \$\d+\s+AND workspace_id = \$\d+\s+AND date_trunc\('milliseconds', updated_at\)/);
  });
});
