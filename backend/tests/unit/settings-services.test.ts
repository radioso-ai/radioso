import { describe, expect, it, vi } from "vitest";

import { defaultAssistantBootstrapSettings, validateAssistantBootstrapSettings } from "../../src/modules/settings/domain/assistantBootstrapSettings.js";
import type { AccessGrant } from "../../src/modules/accessGrants/public.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import type {
  EmbeddingModelTransitionPort,
  EmbeddingModelTransitionState,
} from "../../src/modules/settings/contracts/services.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { PlatformSettingsService } from "../../src/modules/settings/services/platformSettingsService.js";

const transitionState = (
  overrides: Partial<EmbeddingModelTransitionState> = {},
): EmbeddingModelTransitionState => ({
  activeModel: "text-embedding-3-small",
  pendingModel: null,
  status: "idle",
  readiness: null,
  failureReason: null,
  ...overrides,
});

const transitionPort = (
  overrides: Partial<EmbeddingModelTransitionPort> = {},
): EmbeddingModelTransitionPort => ({
  getState: vi.fn().mockResolvedValue(null),
  start: vi.fn().mockResolvedValue(transitionState({
    pendingModel: "text-embedding-3-large",
    status: "building",
    readiness: "building",
  })),
  cancel: vi.fn().mockResolvedValue(transitionState({
    status: "cancelled",
  })),
  reconcile: vi.fn().mockResolvedValue(null),
  ...overrides,
});

describe("settings services", () => {
  const createAgent = (
    workspace: {
      id: string;
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      anonymousChatEnabled: boolean;
      anonymousChatToken: string | null;
      anonymousRateLimit: number;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherPosition: "bottom-right" | "bottom-left";
    },
    overrides: Partial<AgentRecord> = {},
  ): AgentRecord => ({
    id: `${workspace.id}-agent`,
    workspaceId: workspace.id,
    name: workspace.assistantName,
    greetingInstruction: workspace.greetingInstruction,
    assistantDefaultLocale: workspace.assistantDefaultLocale,
    proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
    suggestedQuestionsEnabled: true,
    assistantLinkUtmEnabled: true,
    citationDisplayEnabled: true,
    contactRequestsEnabled: false,
    webhookExportsEnabled: false,
    contactRequestDelivery: { recipientEmails: [], webhook: null },
    customInstruction: "",
    retrievalEnabled: true,
    sourceScope: { mode: "all" },
    skillSettings: {},
    chatModelOverride: null,
    logo: null,
    theme: {
      brand: "#0f172a",
      brandText: "#f8fafc",
      surface: "#ffffff",
      text: "#0f172a",
    },
    branding: {
      hidePoweredBy: false,
      privacyPolicyUrl: null,
    },
    surfaceSettings: {
      authenticatedChat: {
        enabled: true,
      },
      anonymousChat: {
        enabled: workspace.anonymousChatEnabled,
        token: workspace.anonymousChatToken,
      },
      websiteEmbed: {
        enabled: workspace.websiteEmbedEnabled,
        token: workspace.websiteEmbedToken,
        allowedOrigins: workspace.websiteEmbedAllowedOrigins,
        launcherLabel: workspace.websiteEmbedLauncherLabel,
        launcherPosition: workspace.websiteEmbedLauncherPosition,
        theme: {
          brand: "#0f172a",
          brandText: "#f8fafc",
          surface: "#ffffff",
          text: "#0f172a",
        },
        copy: {},
        expertOverrides: {},
      },
      extensions: {},
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });

  const createAgentService = (agent: AgentRecord) => ({
    resolve: vi.fn().mockResolvedValue(agent),
    update: vi.fn(async (_workspaceId: string, _agentId: string, input: Partial<AgentRecord>) => ({
      ...agent,
      ...input,
      surfaceSettings: {
        authenticatedChat: {
          ...agent.surfaceSettings.authenticatedChat,
          ...input.surfaceSettings?.authenticatedChat,
        },
        anonymousChat: {
          ...agent.surfaceSettings.anonymousChat,
          ...input.surfaceSettings?.anonymousChat,
        },
        websiteEmbed: {
          ...agent.surfaceSettings.websiteEmbed,
          ...input.surfaceSettings?.websiteEmbed,
        },
      },
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    })),
    withRotatedTokens: vi.fn((_agent: AgentRecord, input: Partial<AgentRecord>) => input),
  });

  const createPublicLaunchGrant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
    id: "grant-1",
    agentId: "workspace-1-agent",
    workspaceId: "workspace-1",
    label: "website-embed",
    principalKind: "public-launch",
    role: "public",
    channel: "public-link",
    tokenPrefix: "",
    tokenHash: "hash",
    encryptedToken: "encrypted",
    originConstraint: { mode: "allow-all", origins: [] },
    enabled: true,
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  });

  it("aggregates assistant-owned behavior without workspace retrieval tuning", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "it-IT",
      proactiveGreetingEnabled: true,
      anonymousChatEnabled: false,
      anonymousChatToken: null,
      anonymousRateLimit: 10,
      websiteEmbedEnabled: false,
      websiteEmbedToken: null,
      websiteEmbedAllowedOrigins: [],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherPosition: "bottom-right" as const,
    };
    const agentService = createAgentService(createAgent(workspace, {
      suggestedQuestionsEnabled: false,
      customInstruction: "Answer plainly.",
    }));
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn(),
      },
      agentService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    const result = await service.getForWorkspace("workspace-1");

    expect(result.assistant).toMatchObject({
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "it-IT",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: true,
      suggestedQuestionsEnabled: false,
      customInstruction: "Answer plainly.",
    });
    expect(result).not.toHaveProperty("retrieval");
  });

  it("updates one shared settings section without resetting omitted sections", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      anonymousChatEnabled: false,
      anonymousChatToken: null,
      anonymousRateLimit: 10,
      websiteEmbedEnabled: false,
      websiteEmbedToken: null,
      websiteEmbedAllowedOrigins: [],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherPosition: "bottom-right" as const,
    };
    const agentService = createAgentService(createAgent(workspace));
    const workspaceRepository = {
      findById: vi.fn().mockResolvedValue(workspace),
      updateGeneralSettings: vi.fn().mockResolvedValue({
        ...workspace,
        assistantName: "Nora",
      }),
    };
    const service = new PlatformSettingsService({
      workspaceRepository,
      agentService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    await service.updateForWorkspace("workspace-1", {
      assistant: {
        assistantName: "Nora",
      },
    });

    expect(agentService.update).toHaveBeenCalledWith(
      "workspace-1",
      "workspace-1-agent",
      expect.objectContaining({
        name: "Nora",
      }),
    );
    expect(workspaceRepository.updateGeneralSettings).not.toHaveBeenCalled();
  });

  it("delegates website embed script and snippet construction to the configured integration provider", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      assistantName: "Nora",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      anonymousChatEnabled: true,
      anonymousChatToken: "public-token",
      anonymousRateLimit: 10,
      websiteEmbedEnabled: true,
      websiteEmbedToken: "embed-token",
      websiteEmbedAllowedOrigins: ["https://example.com"],
      websiteEmbedLauncherLabel: "Ask Nora",
      websiteEmbedLauncherPosition: "bottom-left" as const,
    };
    const agentService = createAgentService(createAgent(workspace));
    const websiteEmbedIntegration = {
      buildScriptUrl: vi.fn().mockReturnValue("https://widget.radioso.example/radioso-embed.js"),
      buildSnippet: vi.fn().mockReturnValue("<script src=\"https://widget.radioso.example/radioso-embed.js\"></script>"),
    };
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn(),
      },
      agentService,
      publicChatBaseUrl: "http://localhost:3000/chat",
      websiteEmbedIntegration,
    } as never);

    const result = await service.getForWorkspace("workspace-1");

    expect(result.channels.websiteEmbedScriptUrl).toBe("https://widget.radioso.example/radioso-embed.js");
    expect(result.channels.websiteEmbedSnippet).toBe("<script src=\"https://widget.radioso.example/radioso-embed.js\"></script>");
    expect(websiteEmbedIntegration.buildSnippet).toHaveBeenCalledWith(expect.objectContaining({
      websiteEmbedToken: "embed-token",
      websiteEmbedLauncherLabel: "Ask Nora",
    }));
  });

  it("surfaces public launch grant last-used timestamps and lifecycle status by current surface token", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      assistantName: "Nora",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      anonymousChatEnabled: true,
      anonymousChatToken: "anonymous-token",
      anonymousRateLimit: 10,
      websiteEmbedEnabled: true,
      websiteEmbedToken: "embed-token",
      websiteEmbedAllowedOrigins: ["https://example.com"],
      websiteEmbedLauncherLabel: "Ask Nora",
      websiteEmbedLauncherPosition: "bottom-left" as const,
    };
    const anonymousGrant = createPublicLaunchGrant({
      id: "anonymous-grant",
      label: "anonymous-chat",
      lastUsedAt: new Date("2026-02-03T04:05:06.000Z"),
    });
    const websiteEmbedGrant = createPublicLaunchGrant({
      id: "embed-grant",
      label: "website-embed",
      revokedAt: new Date("2026-02-04T04:05:06.000Z"),
    });
    const accessGrantService = {
      resolvePublicLaunchGrant: vi.fn(async (token: string) =>
        token === "anonymous-token"
          ? anonymousGrant
          : token === "embed-token"
            ? websiteEmbedGrant
            : null,
      ),
      revokeGrant: vi.fn(),
    };
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn(),
      },
      agentService: createAgentService(createAgent(workspace)),
      accessGrantService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    const result = await service.getForWorkspace("workspace-1");

    expect(accessGrantService.resolvePublicLaunchGrant).toHaveBeenCalledWith("anonymous-token");
    expect(accessGrantService.resolvePublicLaunchGrant).toHaveBeenCalledWith("embed-token");
    expect(result.channels).toMatchObject({
      anonymousChatLastUsedAt: "2026-02-03T04:05:06.000Z",
      websiteEmbedLastUsedAt: null,
    });
  });

  it("emits channel audit events from the shared settings update path", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      anonymousChatEnabled: false,
      anonymousChatToken: "old-anonymous-token",
      anonymousRateLimit: 10,
      websiteEmbedEnabled: false,
      websiteEmbedToken: "old-embed-token",
      websiteEmbedAllowedOrigins: [],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherPosition: "bottom-right" as const,
    };
    const agentService = createAgentService(createAgent(workspace));
    const auditService = {
      record: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn().mockImplementation(async (_workspaceId, input) => ({
          ...workspace,
          ...input,
        })),
      },
      agentService,
      auditService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    await service.updateForWorkspace(
      "workspace-1",
      {
        channels: {
          anonymousChatEnabled: true,
          rotateAnonymousChatToken: true,
          websiteEmbedEnabled: true,
          websiteEmbedAllowedOrigins: ["https://example.com"],
          websiteEmbedLauncherPosition: "bottom-left",
          rotateWebsiteEmbedToken: true,
        },
      },
      { accountId: "account-1" },
    );

    expect(auditService.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "anonymous_chat.enabled",
      eventStatus: "success",
      metadata: {},
    });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "anonymous_chat.token_rotated",
      eventStatus: "success",
      metadata: { enabled: true },
    });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "website_embed.enabled",
      eventStatus: "success",
      metadata: {
        allowedOrigins: ["https://example.com"],
        launcherPosition: "bottom-left",
      },
    });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "website_embed.token_rotated",
      eventStatus: "success",
      metadata: {
        enabled: true,
        allowedOrigins: ["https://example.com"],
      },
    });
  });

  it("returns saved ingestion settings even when success audit logging fails", async () => {
    const settings = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(settings),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", settings)).resolves.toEqual(settings);
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "ingestion_settings.update",
      eventStatus: "success",
    });
  });

  it("preserves the saved embedding model when older ingestion clients omit it", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      embeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(repository, auditService as never);

    const settings = await service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "structured_semantic",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
    });

    expect(settings.embeddingModel).toBe("text-embedding-3-large");
    expect(repository.upsert).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        embeddingModel: "text-embedding-3-large",
        pendingEmbeddingModel: null,
      }),
    );
  });

  it("treats an older client's echo of the active legacy model as an unchanged selection", async () => {
    const legacyModel = "legacy-compatible-embedding";
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      embeddingModel: legacyModel,
    } as unknown as ReturnType<typeof defaultIngestionSettings>;
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = { record: vi.fn() };
    const service = new IngestionSettingsService(
      repository,
      auditService as never,
    );

    const settings = await service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "structured_semantic",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: legacyModel,
      documentEnrichmentEnabled: true,
    });

    expect(settings).toMatchObject({
      embeddingModel: legacyModel,
      pendingEmbeddingModel: null,
      documentEnrichmentEnabled: true,
    });
  });

  it("rejects a different unsupported model without starting a transition", async () => {
    const legacyModel = "legacy-compatible-embedding";
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      embeddingModel: legacyModel,
    } as unknown as ReturnType<typeof defaultIngestionSettings>;
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const auditService = { record: vi.fn() };
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "different-unsupported-model",
    } as never)).rejects.toThrow(
      "embeddingModel must be a supported embedding model",
    );
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("keeps the supported embedding choices fixed to the existing four-model catalog", () => {
    const service = new IngestionSettingsService(
      {} as never,
      { record: vi.fn() } as never,
    );

    expect(service.listSupportedEmbeddingModels()).toEqual([
      "text-embedding-3-small",
      "text-embedding-3-large",
      "text-embedding-ada-002",
      "gemini-embedding-001",
    ]);
  });

  it("delegates embedding model changes to the internal transition port", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = {
      record: vi.fn(),
    };
    const transitions = transitionPort();
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    const settings = await service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    });

    expect(settings.embeddingModel).toBe("text-embedding-3-small");
    expect(settings.pendingEmbeddingModel).toBe("text-embedding-3-large");
    expect(transitions.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    });
    expect(transitions.reconcile).toHaveBeenCalledWith("workspace-1");
  });

  it("does not persist a pending setting when transition startup fails", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = {
      record: vi.fn(),
    };
    const startError = new Error("transition unavailable");
    const transitions = transitionPort({
      start: vi.fn().mockRejectedValue(startError),
    });
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    })).rejects.toBe(startError);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("fails safely when the internal transition coordinator is not composed", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const service = new IngestionSettingsService(
      repository as never,
      { record: vi.fn() } as never,
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    })).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Embedding model transitions are temporarily unavailable",
    });
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("rejects replacing an embedding model change while one is pending", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "gemini-embedding-001",
    })).rejects.toThrow("embeddingModel change already pending for text-embedding-3-large");
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("projects transition state on reads without triggering promotion", async () => {
    const pending = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(pending),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(transitionState({
        activeModel: "text-embedding-3-large",
        status: "promoted",
      })),
    });
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-large",
      pendingEmbeddingModel: null,
    });
    expect(transitions.getState).toHaveBeenCalledWith("workspace-1");
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("durably clears a failed pending model before accepting a new selection", async () => {
    let stored = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as
        | "text-embedding-3-large"
        | "gemini-embedding-001"
        | null,
    };
    let revision = "1";
    const clearPendingEmbeddingModel = vi.fn(
      async (
        _workspaceId: string,
        expectedPendingModel: string,
        expectedRevision: string,
      ) => {
        if (
          stored.pendingEmbeddingModel !== expectedPendingModel
          || revision !== expectedRevision
        ) {
          return null;
        }
        stored = {
          ...stored,
          pendingEmbeddingModel: null,
        };
        revision = "2";
        return stored;
      },
    );
    const repository = {
      findByWorkspaceId: vi.fn(async () => stored),
      findVersionedByWorkspaceId: vi.fn(async () => ({
        settings: stored,
        revision,
      })),
      clearPendingEmbeddingModel,
      upsert: vi.fn(async (_workspaceId: string, input: typeof stored) => {
        stored = { ...stored, ...input };
        revision = String(Number(revision) + 1);
        return stored;
      }),
    };
    const failed = transitionState({
      status: "failed",
      readiness: "unavailable",
      failureReason: "terminal_failure",
    });
    const building = transitionState({
      pendingModel: "gemini-embedding-001",
      status: "building",
      readiness: "building",
    });
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(failed),
      start: vi.fn().mockResolvedValue(building),
      reconcile: vi.fn().mockResolvedValue(building),
    });
    const service = new IngestionSettingsService(
      repository as never,
      { record: vi.fn() } as never,
      undefined,
      transitions,
    );

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: null,
    });
    expect(clearPendingEmbeddingModel).toHaveBeenCalledWith(
      "workspace-1",
      "text-embedding-3-large",
      "1",
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "gemini-embedding-001",
    })).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: "gemini-embedding-001",
    });
    expect(transitions.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "gemini-embedding-001",
    });
  });

  it("repairs a failed pending model during a direct update without a preceding read", async () => {
    let stored = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as
        | "text-embedding-3-large"
        | "text-embedding-ada-002"
        | null,
    };
    let revision = "1";
    const clearPendingEmbeddingModel = vi.fn(
      async (
        _workspaceId: string,
        expectedPendingModel: string,
        expectedRevision: string,
      ) => {
        if (
          stored.pendingEmbeddingModel !== expectedPendingModel
          || revision !== expectedRevision
        ) {
          return null;
        }
        stored = { ...stored, pendingEmbeddingModel: null };
        revision = "2";
        return stored;
      },
    );
    const repository = {
      findByWorkspaceId: vi.fn(async () => stored),
      findVersionedByWorkspaceId: vi.fn(async () => ({
        settings: stored,
        revision,
      })),
      clearPendingEmbeddingModel,
      upsert: vi.fn(async (_workspaceId: string, input: typeof stored) => {
        stored = { ...stored, ...input };
        revision = String(Number(revision) + 1);
        return stored;
      }),
    };
    const building = transitionState({
      pendingModel: "text-embedding-ada-002",
      status: "building",
      readiness: "building",
    });
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(transitionState({
        status: "failed",
        readiness: "unavailable",
        failureReason: "terminal_failure",
      })),
      start: vi.fn().mockResolvedValue(building),
      reconcile: vi.fn().mockResolvedValue(building),
    });
    const service = new IngestionSettingsService(
      repository as never,
      { record: vi.fn() } as never,
      undefined,
      transitions,
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-ada-002",
    })).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: "text-embedding-ada-002",
    });

    expect(clearPendingEmbeddingModel).toHaveBeenCalledWith(
      "workspace-1",
      "text-embedding-3-large",
      "1",
    );
    expect(transitions.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-ada-002",
    });
  });

  it("does not clear a concurrently restarted transition to the same model", async () => {
    const original = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const restarted = {
      ...original,
      updatedAt: new Date(original.updatedAt.getTime() + 1),
    };
    const findByWorkspaceId = vi.fn().mockResolvedValue(restarted);
    const findVersionedByWorkspaceId = vi.fn()
      .mockResolvedValueOnce({
        settings: original,
        revision: "1",
      })
      .mockResolvedValueOnce({
        settings: restarted,
        revision: "2",
      });
    const clearPendingEmbeddingModel = vi.fn(
      async (
        _workspaceId: string,
        _expectedPendingModel: string,
        _expectedRevision: string,
      ) => null,
    );
    const service = new IngestionSettingsService(
      {
        findByWorkspaceId,
        findVersionedByWorkspaceId,
        clearPendingEmbeddingModel,
        upsert: vi.fn(),
      } as never,
      { record: vi.fn() } as never,
      undefined,
      transitionPort({
        getState: vi.fn().mockResolvedValue(transitionState({
          status: "failed",
          readiness: "unavailable",
          failureReason: "terminal_failure",
        })),
      }),
    );

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      pendingEmbeddingModel: "text-embedding-3-large",
    });
    expect(clearPendingEmbeddingModel).toHaveBeenCalledWith(
      "workspace-1",
      "text-embedding-3-large",
      "1",
    );
  });

  it("keeps persisted settings when no internal profile has been materialized", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const transitions = transitionPort();
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: null,
    });
    expect(transitions.getState).toHaveBeenCalledWith("workspace-1");
  });

  it("resumes a legacy persisted pending model through the internal transition port", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(null),
      start: vi.fn().mockResolvedValue(transitionState({
        pendingModel: "text-embedding-3-large",
        status: "building",
        readiness: "building",
      })),
    });
    const service = new IngestionSettingsService(
      repository as never,
      { record: vi.fn() } as never,
      undefined,
      transitions,
    );

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: "text-embedding-3-large",
    });
    expect(transitions.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    });
    expect(transitions.reconcile).not.toHaveBeenCalled();
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("attaches a legacy pending model to an existing idle embedding profile", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(transitionState()),
    });
    const service = new IngestionSettingsService(
      {
        findByWorkspaceId: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn(),
      } as never,
      { record: vi.fn() } as never,
      undefined,
      transitions,
    );

    await service.getForWorkspace("workspace-1");

    expect(transitions.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    });
  });

  it("cancels a pending embedding model change through the transition port", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = {
      record: vi.fn(),
    };
    const transitions = transitionPort({
      getState: vi.fn().mockResolvedValue(transitionState({
        pendingModel: "text-embedding-3-large",
        status: "building",
        readiness: "building",
      })),
    });
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    await expect(service.cancelPendingEmbeddingModel("workspace-1")).resolves.toMatchObject({
      pendingEmbeddingModel: null,
    });
    expect(transitions.cancel).toHaveBeenCalledWith("workspace-1");
    expect(repository.upsert).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        embeddingModel: "text-embedding-3-small",
        pendingEmbeddingModel: null,
      }),
    );
  });

  it("rejects switching to an embedding model without a configured provider", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"],
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "gemini-embedding-001",
    })).rejects.toThrow("embeddingModel gemini-embedding-001 requires a configured embedding provider");
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("accepts an immediately promoted transition result for an empty workspace", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => ({
        ...existing,
        ...input,
      })),
    };
    const auditService = {
      record: vi.fn(),
    };
    const transitions = transitionPort({
      start: vi.fn().mockResolvedValue(transitionState({
        activeModel: "text-embedding-3-large",
        status: "promoted",
      })),
    });
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      undefined,
      transitions,
    );

    const settings = await service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    });

    expect(settings.embeddingModel).toBe("text-embedding-3-large");
    expect(settings.pendingEmbeddingModel).toBeNull();
  });

  it("rethrows the original ingestion save error when failure audit logging also fails", async () => {
    const writeError = new Error("write failed");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockRejectedValue(writeError),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const service = new IngestionSettingsService(repository, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", defaultIngestionSettings("workspace-1"))).rejects.toBe(
      writeError,
    );
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "ingestion_settings.update",
      eventStatus: "failure",
    });
  });

  it("normalizes assistant bootstrap settings and treats blank locale as null", () => {
    expect(
      validateAssistantBootstrapSettings({
        assistantName: "  Marta  ",
        greetingInstruction: " Warm and concise ",
        assistantDefaultLocale: " ",
        proactiveGreetingEnabled: true,
      }),
    ).toEqual({
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: true,
    });
  });

  it("exposes blank assistant bootstrap defaults", () => {
    expect(defaultAssistantBootstrapSettings()).toEqual({
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
    });
  });
});
