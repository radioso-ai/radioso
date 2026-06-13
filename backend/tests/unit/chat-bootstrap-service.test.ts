import { describe, expect, it, vi } from "vitest";

import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import { AgentService } from "../../src/modules/agents/public.js";
import {
  InMemoryAgentRepository,
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

const createProductAnalyticsService = () => ({
  track: vi.fn(async () => null),
});

const createAgentService = (
  workspaceRepository: InMemoryWorkspaceRepository,
) => new AgentService(new InMemoryAgentRepository(), workspaceRepository);

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
    const productAnalyticsService = createProductAnalyticsService();
    const agentService = createAgentService(workspaceRepository);
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      chatGateway as never,
      auditService,
      undefined,
      productAnalyticsService,
      agentService,
    );

    const result = await service.startConversation({
      workspaceId: workspace.id,
      accountId: "account-1",
      userExpectedLocale: "it-IT",
    });

    expect(result).toMatchObject({
      answer: expect.any(String),
      bootstrapGreetingId: expect.any(String),
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
    const productAnalyticsService = createProductAnalyticsService();
    const agentService = createAgentService(workspaceRepository);
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway as never,
      createAuditService(),
      undefined,
      productAnalyticsService,
      agentService,
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

  it("generates and caches bootstrap greetings for website embeds", async () => {
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
      answer: vi.fn(async () => "Hello from the model."),
      streamAnswer: vi.fn(),
    };
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      chatGateway as never,
      createAuditService(),
      undefined,
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
    );

    const firstEmbedGreeting = await service.startConversation({
      workspaceId: workspace.id,
      sourceChannel: "website_embed",
      userExpectedLocale: "en",
    });
    expect(firstEmbedGreeting?.bootstrapGreetingId).toEqual(expect.any(String));

    const cachedEmbedGreeting = await service.startConversation({
      workspaceId: workspace.id,
      sourceChannel: "website_embed",
      userExpectedLocale: "en",
    });

    expect(cachedEmbedGreeting).toMatchObject({
      answer: "Hello from the model.",
      bootstrapGreetingId: firstEmbedGreeting?.bootstrapGreetingId,
    });
    expect(chatGateway.answer).toHaveBeenCalledTimes(1);
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
      undefined,
      undefined,
      createAgentService(workspaceRepository),
    );

    await expect(service.startConversation({ workspaceId: workspace.id })).resolves.toBeNull();
  });

  it("creates a zero-config default agent before operator-specific answer instructions are set", async () => {
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
    const agentService = createAgentService(workspaceRepository);
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway as never,
      createAuditService(),
      undefined,
      undefined,
      agentService,
    );

    await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });
    const defaultAgent = await agentService.resolve(workspace.id);
    expect(defaultAgent.customInstruction).toBe("");
    expect(defaultAgent.skillSettings).toEqual({});
    expect(defaultAgent.retrievalEnabled).toBe(true);
    expect(defaultAgent.suggestedQuestionsEnabled).toBe(true);
    expect(chatGateway.answer).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.not.stringContaining("Answer instruction:"),
    }));

    await agentService.update(workspace.id, defaultAgent.id, {
      customInstruction: "Help visitors book retreats.",
    });
    await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(chatGateway.answer).toHaveBeenCalledTimes(2);
    expect(chatGateway.answer).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Answer instruction: Help visitors book retreats."),
    }));
  });
});
