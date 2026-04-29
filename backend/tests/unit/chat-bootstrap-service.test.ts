import { describe, expect, it, vi } from "vitest";

import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import {
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryConversationRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

const createRetrievalSettingsService = (customInstruction = "") => ({
  getForWorkspace: vi.fn(async (workspaceId: string) => ({
    ...defaultRetrievalSettings(workspaceId),
    customInstruction,
  })),
});

describe("chat bootstrap service", () => {
  it("creates a first assistant turn using request locale override", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
    });

    const conversationRepository = new InMemoryConversationRepository();
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const chatGateway = {
      answer: vi.fn(async () => "Ciao! Sono Marta, la tua guida del museo."),
      streamAnswer: vi.fn(),
    };
    const auditService = createAuditService();
    const retrievalSettingsService = createRetrievalSettingsService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      conversationRepository,
      chatGateway as never,
      auditService,
      retrievalSettingsService,
    );

    const result = await service.startConversation({
      workspaceId: workspace.id,
      accountId: "account-1",
      userExpectedLocale: "it-IT",
    });

    expect(result).toMatchObject({
      conversationId: expect.any(String),
      answer: expect.any(String),
      citations: [],
    });
    expect(auditService.events[0]?.metadata?.workflow).toBe("chat.bootstrap");
    expect(auditService.events[0]?.metadata?.executionClass).toBe("interactive_synchronous");
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
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      new InMemoryConversationRepository(),
      chatGateway as never,
      createAuditService(),
      retrievalSettingsService,
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
  });

  it("returns null when bootstrap is inactive", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      new InMemoryConversationRepository(),
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
      new InMemoryConversationRepository(),
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
