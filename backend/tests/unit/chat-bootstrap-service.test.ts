import { describe, expect, it, vi } from "vitest";

import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import {
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

const createRetrievalSettingsService = (customInstruction = "") => ({
  getForWorkspace: vi.fn(async (workspaceId: string) => ({
    ...defaultRetrievalSettings(workspaceId),
    customInstruction,
  })),
});

const createProductAnalyticsService = () => ({
  track: vi.fn(async () => null),
});

describe("chat bootstrap service", () => {
  it("returns an ephemeral first assistant turn and records chat started analytics", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
    });

    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const chatGateway = {
      answer: vi.fn(async () => "Ciao! Sono Marta, la tua guida del museo."),
      streamAnswer: vi.fn(),
    };
    const auditService = createAuditService();
    const retrievalSettingsService = createRetrievalSettingsService();
    const productAnalyticsService = createProductAnalyticsService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      chatGateway as never,
      auditService,
      retrievalSettingsService,
      undefined,
      productAnalyticsService,
    );

    const result = await service.startConversation({
      workspaceId: workspace.id,
      accountId: "account-1",
      userExpectedLocale: "it-IT",
    });

    expect(result).toMatchObject({
      answer: expect.any(String),
      citations: [],
    });
    expect(result).not.toHaveProperty("conversationId");
    expect(auditService.events[0]?.metadata?.workflow).toBe("chat.bootstrap");
    expect(auditService.events[0]?.metadata?.executionClass).toBe("interactive_synchronous");
    expect(auditService.events[0]?.metadata).not.toHaveProperty("conversationId");
    expect(productAnalyticsService.track).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "chat.started",
      workspaceId: workspace.id,
      accountId: "account-1",
      actorType: "authenticated_user",
      subjectType: "workspace",
      subjectId: workspace.id,
      properties: expect.objectContaining({
        sourceChannel: null,
        sourceOrigin: null,
        localeUsed: "it-IT",
        cacheHit: false,
        proactiveGreetingEnabled: true,
      }),
      source: "backend",
    }));
  });

  it("reuses a cached greeting until the locale changes", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
    });

    const chatGateway = {
      answer: vi
        .fn()
        .mockResolvedValueOnce("Ciao! Sono Marta, la tua guida del museo.")
        .mockResolvedValueOnce("Hello! I'm Marta, your museum guide."),
      streamAnswer: vi.fn(),
    };
    const retrievalSettingsService = createRetrievalSettingsService();
    const productAnalyticsService = createProductAnalyticsService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway as never,
      createAuditService(),
      retrievalSettingsService,
      undefined,
      productAnalyticsService,
    );

    const firstItalian = await service.startConversation({
      workspaceId: workspace.id,
      userExpectedLocale: "it-IT",
    });
    const secondItalian = await service.startConversation({
      workspaceId: workspace.id,
      userExpectedLocale: "it-IT",
    });
    const english = await service.startConversation({
      workspaceId: workspace.id,
      userExpectedLocale: "en-US",
    });

    expect(firstItalian?.answer).toBeDefined();
    expect(secondItalian?.answer).toBe(firstItalian?.answer);
    expect(english?.answer).toBeDefined();
    expect(english?.answer).not.toBe(firstItalian?.answer);
    expect(chatGateway.answer).toHaveBeenCalledTimes(2);
    expect(productAnalyticsService.track).toHaveBeenCalledTimes(3);
    expect(productAnalyticsService.track).toHaveBeenNthCalledWith(2, expect.objectContaining({
      properties: expect.objectContaining({
        cacheHit: true,
      }),
    }));
  });

  it("returns null when bootstrap is inactive", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      {
        answer: vi.fn(),
        streamAnswer: vi.fn(),
      } as never,
      createAuditService(),
      createRetrievalSettingsService(),
    );

    await expect(service.startConversation({ workspaceId: workspace.id })).resolves.toBeNull();
  });

  it("includes answer instruction in the greeting prompt and cache fingerprint", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
    });

    const chatGateway = {
      answer: vi
        .fn()
        .mockResolvedValueOnce("Hello from the course guide.")
        .mockResolvedValueOnce("Hello from the booking guide."),
      streamAnswer: vi.fn(),
    };
    const retrievalSettingsService = createRetrievalSettingsService("Help visitors choose courses.");
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway as never,
      createAuditService(),
      retrievalSettingsService,
    );

    await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });
    expect(chatGateway.answer).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Answer instruction: Help visitors choose courses."),
    }));

    retrievalSettingsService.getForWorkspace.mockResolvedValue({
      ...defaultRetrievalSettings(workspace.id),
      customInstruction: "Help visitors book retreats.",
    });
    await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(chatGateway.answer).toHaveBeenCalledTimes(2);
    expect(chatGateway.answer).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Answer instruction: Help visitors book retreats."),
    }));
  });
});
