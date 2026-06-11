import { describe, expect, it, vi } from "vitest";

import { defaultAssistantBootstrapSettings, validateAssistantBootstrapSettings } from "../../src/modules/settings/domain/assistantBootstrapSettings.js";
import type { AccessGrant } from "../../src/modules/accessGrants/public.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { PlatformSettingsService } from "../../src/modules/settings/services/platformSettingsService.js";

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

  it("keeps the active embedding model and records a pending model when documents already exist", async () => {
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
    const documentRepository = {
      summarizeWorkspace: vi.fn().mockResolvedValue({
        documentCount: 2,
      }),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never, documentRepository as never);

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
  });

  it("queues workspace reprocessing when a model change becomes pending", async () => {
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
    const documentRepository = {
      summarizeWorkspace: vi.fn().mockResolvedValue({
        documentCount: 2,
      }),
    };
    const reprocessService = {
      reprocessWorkspace: vi.fn().mockResolvedValue({ status: "queued" }),
    };
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      documentRepository as never,
      undefined,
      reprocessService,
    );

    await service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    });

    expect(reprocessService.reprocessWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("rolls back a newly pending model when automatic workspace reprocessing fails", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const writtenInputs: unknown[] = [];
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async (_workspaceId: string, input: typeof existing) => {
        writtenInputs.push(input);
        return {
          ...existing,
          ...input,
        };
      }),
    };
    const auditService = {
      record: vi.fn(),
    };
    const documentRepository = {
      summarizeWorkspace: vi.fn().mockResolvedValue({
        documentCount: 2,
      }),
    };
    const reprocessError = new Error("queue down");
    const reprocessService = {
      reprocessWorkspace: vi.fn().mockRejectedValue(reprocessError),
    };
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
      documentRepository as never,
      undefined,
      reprocessService,
    );

    await expect(service.updateForWorkspace("workspace-1", {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "text-embedding-3-large",
    })).rejects.toBe(reprocessError);
    expect(writtenInputs).toEqual([
      expect.objectContaining({
        embeddingModel: "text-embedding-3-small",
        pendingEmbeddingModel: "text-embedding-3-large",
      }),
      expect.objectContaining({
        embeddingModel: "text-embedding-3-small",
        pendingEmbeddingModel: null,
      }),
    ]);
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

  it("checks pending embedding model promotion when settings are read", async () => {
    const pending = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const promoted = {
      ...defaultIngestionSettings("workspace-1"),
      embeddingModel: "text-embedding-3-large" as const,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(pending),
      promotePendingEmbeddingModelIfReady: vi.fn().mockResolvedValue(promoted),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never);

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-large",
      pendingEmbeddingModel: null,
    });
    expect(repository.promotePendingEmbeddingModelIfReady).toHaveBeenCalledWith("workspace-1");
  });

  it("does not attempt pending model promotion on settings reads without a pending model", async () => {
    const existing = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      promotePendingEmbeddingModelIfReady: vi.fn(),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never);

    await expect(service.getForWorkspace("workspace-1")).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: null,
    });
    expect(repository.promotePendingEmbeddingModelIfReady).not.toHaveBeenCalled();
  });

  it("cancels a pending embedding model change without requiring the reprocess queue", async () => {
    const existing = {
      ...defaultIngestionSettings("workspace-1"),
      pendingEmbeddingModel: "text-embedding-3-large" as const,
    };
    const cleared = {
      ...existing,
      pendingEmbeddingModel: null,
    };
    const repository = {
      findByWorkspaceId: vi.fn().mockResolvedValue(existing),
      clearPendingEmbeddingModel: vi.fn().mockResolvedValue(cleared),
      upsert: vi.fn(),
    };
    const auditService = {
      record: vi.fn(),
    };
    const service = new IngestionSettingsService(
      repository as never,
      auditService as never,
    );

    await expect(service.cancelPendingEmbeddingModel("workspace-1")).resolves.toMatchObject({
      pendingEmbeddingModel: null,
    });
    expect(repository.clearPendingEmbeddingModel).toHaveBeenCalledWith("workspace-1");
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
      undefined,
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

  it("switches the active embedding model immediately for empty workspaces", async () => {
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
    const documentRepository = {
      summarizeWorkspace: vi.fn().mockResolvedValue({
        documentCount: 0,
      }),
    };
    const service = new IngestionSettingsService(repository as never, auditService as never, documentRepository as never);

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
