import { describe, expect, it, vi } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
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

const agentRow = (outputModes: Record<string, unknown>) => ({
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

    const agent = await repository.findById("agent-1");

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

    const agent = await repository.findById("agent-1");

    expect(agent).not.toBeNull();
    expect(getWebsiteEmbedSurfaceSettings(agent!)).toEqual(websiteEmbedDefaults());
  });
});
