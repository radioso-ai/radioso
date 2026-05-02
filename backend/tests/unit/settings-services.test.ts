import { describe, expect, it, vi } from "vitest";

import { defaultAssistantBootstrapSettings, validateAssistantBootstrapSettings } from "../../src/modules/settings/domain/assistantBootstrapSettings.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { PlatformSettingsService } from "../../src/modules/settings/services/platformSettingsService.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";

describe("settings services", () => {
  it("aggregates assistant-owned behavior separately from retrieval-owned tuning", async () => {
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
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
    };
    const retrieval = {
      ...defaultRetrievalSettings("workspace-1"),
      queryRewriteEnabled: true,
      conversationMode: "exploratory" as const,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 1,
      customInstruction: "Answer plainly.",
    };
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn(),
      },
      retrievalSettingsService: {
        getForWorkspace: vi.fn().mockResolvedValue(retrieval),
        listMetadataFieldSuggestions: vi.fn().mockResolvedValue([]),
        updateForWorkspace: vi.fn(),
      },
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    const result = await service.getForWorkspace("workspace-1");

    expect(result.assistant).toMatchObject({
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "it-IT",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: true,
      conversationMode: "exploratory",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 1,
      customInstruction: "Answer plainly.",
    });
    expect(result.retrieval).toMatchObject({
      queryRewriteEnabled: true,
      vectorTopK: 15,
    });
    expect(result.retrieval).not.toHaveProperty("conversationMode");
    expect(result.retrieval).not.toHaveProperty("customInstruction");
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
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
    };
    const retrieval = defaultRetrievalSettings("workspace-1");
    const workspaceRepository = {
      findById: vi.fn().mockResolvedValue(workspace),
      updateGeneralSettings: vi.fn().mockResolvedValue({
        ...workspace,
        assistantName: "Nora",
      }),
    };
    const retrievalSettingsService = {
      getForWorkspace: vi.fn().mockResolvedValue(retrieval),
      listMetadataFieldSuggestions: vi.fn().mockResolvedValue([]),
      updateForWorkspace: vi.fn(),
    };
    const service = new PlatformSettingsService({
      workspaceRepository,
      retrievalSettingsService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    await service.updateForWorkspace("workspace-1", {
      assistant: {
        assistantName: "Nora",
      },
    });

    expect(workspaceRepository.updateGeneralSettings).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        assistantName: "Nora",
        anonymousChatEnabled: false,
        anonymousRateLimit: 10,
        websiteEmbedEnabled: false,
      }),
    );
    expect(retrievalSettingsService.updateForWorkspace).not.toHaveBeenCalled();
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
      websiteEmbedLauncherIcon: "sparkles",
      websiteEmbedLauncherPosition: "bottom-left",
    };
    const retrieval = defaultRetrievalSettings("workspace-1");
    const websiteEmbedIntegration = {
      buildScriptUrl: vi.fn().mockReturnValue("https://widget.radioso.example/radioso-embed.js"),
      buildSnippet: vi.fn().mockReturnValue("<script src=\"https://widget.radioso.example/radioso-embed.js\"></script>"),
    };
    const service = new PlatformSettingsService({
      workspaceRepository: {
        findById: vi.fn().mockResolvedValue(workspace),
        updateGeneralSettings: vi.fn(),
      },
      retrievalSettingsService: {
        getForWorkspace: vi.fn().mockResolvedValue(retrieval),
        listMetadataFieldSuggestions: vi.fn().mockResolvedValue([]),
        updateForWorkspace: vi.fn(),
      },
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
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
    };
    const retrieval = defaultRetrievalSettings("workspace-1");
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
      retrievalSettingsService: {
        getForWorkspace: vi.fn().mockResolvedValue(retrieval),
        listMetadataFieldSuggestions: vi.fn().mockResolvedValue([]),
        updateForWorkspace: vi.fn(),
      },
      auditService,
      publicChatBaseUrl: "http://localhost:3000/chat",
    } as never);

    await service.updateForWorkspace(
      "workspace-1",
      {
        channels: {
          anonymousChatEnabled: true,
          anonymousRateLimit: 20,
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
      metadata: { anonymousRateLimit: 20 },
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

  it("returns saved retrieval settings even when success audit logging fails", async () => {
    const settings = defaultRetrievalSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(settings),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const analyticsService = {
      track: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RetrievalSettingsService(repository, auditService as never, undefined, analyticsService as never);

    await expect(service.updateForWorkspace("workspace-1", settings)).resolves.toEqual(settings);
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
        eventType: "settings.update",
        eventStatus: "success",
      });
    expect(analyticsService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "retrieval_settings.updated",
        workspaceId: "workspace-1",
      }),
    );
  });

  it("rethrows the original retrieval save error when failure audit logging also fails", async () => {
    const writeError = new Error("write failed");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockRejectedValue(writeError),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const analyticsService = {
      track: vi.fn(),
    };
    const service = new RetrievalSettingsService(repository, auditService as never, undefined, analyticsService as never);

    await expect(service.updateForWorkspace("workspace-1", defaultRetrievalSettings("workspace-1"))).rejects.toBe(
      writeError,
    );
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
        eventType: "settings.update",
        eventStatus: "failure",
      });
    expect(analyticsService.track).not.toHaveBeenCalled();
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
    const service = new IngestionSettingsService(repository, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", settings)).resolves.toEqual(settings);
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "ingestion_settings.update",
      eventStatus: "success",
    });
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
