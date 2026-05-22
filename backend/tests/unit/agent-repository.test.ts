import { describe, expect, it, vi } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
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
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const repositoryWithRow = (row: ReturnType<typeof agentRow>, registry: AgentSurfaceExtensionRegistry) =>
  new AgentRepository({
    queryOptional: async () => row,
  } as never, registry);

describe("AgentRepository", () => {
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

  it("stores manual document selection as an unassigned source filter", async () => {
    const realSourceId = "11111111-1111-1111-1111-111111111111";
    const query = vi.fn(async (text: string) => {
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
      sourceScope: {
        mode: "selected",
        sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, realSourceId],
      },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO agents"),
      expect.not.arrayContaining([MANUALLY_ADDED_DOCUMENTS_SOURCE_ID]),
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO agent_document_sources"),
      [expect.any(String), [null, realSourceId]],
    );
  });
});
