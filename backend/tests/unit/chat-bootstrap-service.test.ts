import { describe, expect, it, vi } from "vitest";

import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import {
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryConversationRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

describe("chat bootstrap service", () => {
  it("creates a first assistant turn using request locale override", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      assistantRole: "Museum guide",
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
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      conversationRepository,
      chatGateway as never,
      auditService,
    );

    const result = await service.startConversation({
      workspaceId: workspace.id,
      accountId: "account-1",
      userExpectedLocale: "it-IT",
    });

    expect(result).toMatchObject({
      conversationId: expect.any(String),
      answer: "Ciao! Sono Marta, la tua guida del museo.",
      citations: [],
    });
    expect(chatGateway.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("locale it-IT"),
      }),
    );
    expect(auditService.events[0]?.metadata?.workflow).toBe("chat.bootstrap");
    expect(auditService.events[0]?.metadata?.executionClass).toBe("interactive_synchronous");
  });

  it("reuses a cached greeting until the locale changes", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      assistantRole: "Museum guide",
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
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      new InMemoryConversationRepository(),
      chatGateway as never,
      createAuditService(),
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

    expect(firstItalian?.answer).toBe("Ciao! Sono Marta, la tua guida del museo.");
    expect(secondItalian?.answer).toBe("Ciao! Sono Marta, la tua guida del museo.");
    expect(english?.answer).toBe("Hello! I'm Marta, your museum guide.");
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
    );

    await expect(service.startConversation({ workspaceId: workspace.id })).resolves.toBeNull();
  });
});
