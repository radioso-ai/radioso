import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ChatBootstrapService } from "../../src/modules/chat/services/chatBootstrapService.js";
import { AgentService, type AgentRevision } from "../../src/modules/agents/public.js";
import { notFound } from "../../src/shared/domain/errors.js";
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

const createUsageLimitPolicy = () => ({
  reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })),
  reserveDocument: vi.fn(),
  reserveIndexedStorage: vi.fn(),
  reserveMonthlyIndexedContent: vi.fn(),
});

const buildExactContent = (overrides?: {
  chips?: string[];
  variants?: Array<{ locale: string; body: string; chipLabels: Record<string, string> }>;
}) => ({
  chips: overrides?.chips ?? [],
  variants: overrides?.variants ?? [
    { locale: "en", body: "Hello from the exact greeting.", chipLabels: {} },
  ],
});

const buildRevision = (
  greeting: { exactWordsEnabled: boolean; exactContent: ReturnType<typeof buildExactContent> | null },
): AgentRevision => ({
  id: `revision-${randomUUID()}`,
  snapshot: {
    customInstruction: null,
    directives: [],
    routines: [],
    contextVariableEnablements: [],
    greeting,
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(),
  publishedAt: new Date(),
  publishedVersion: 1,
});

/** A minimal double for the port `resolveRevisionGreeting` reuses (spec 1150 F13):
 * `resolveNew` for a production start, `resolvePinned` for a trusted test-execution
 * bootstrap. Neither call constructs a real `AgentRecord`; nothing under test reads it. */
const createAgentRevisionRuntimeResolver = (revision: AgentRevision | null) => ({
  resolveNew: vi.fn(async () => {
    if (!revision) {
      throw notFound("Agent is not published");
    }
    return {
      revisionId: revision.id,
      revision,
      contextVariableEnablements: revision.snapshot.contextVariableEnablements,
      agent: {} as never,
    };
  }),
  resolvePinned: vi.fn(async () => {
    if (!revision) {
      throw notFound("Agent revision is unavailable");
    }
    return {
      revisionId: revision.id,
      revision,
      contextVariableEnablements: revision.snapshot.contextVariableEnablements,
      agent: {} as never,
    };
  }),
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
    const productAnalyticsService = createProductAnalyticsService();
    const agentService = createAgentService(workspaceRepository);
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      chatGateway,
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
      chatGateway,
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
      chatGateway,
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

  it("generates through the bootstrap guard for a neutral named pinned test override", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    const agentService = createAgentService(workspaceRepository);
    const chatGateway = { answer: vi.fn(async () => "Ciao!"), streamAnswer: vi.fn() };
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway,
      createAuditService(),
      undefined,
      undefined,
      agentService,
    );
    const defaultAgent = await agentService.resolve(workspace.id);

    await expect(service.startConversation({
      workspaceId: workspace.id,
      revisionId: "revision-1",
      agentOverride: { ...defaultAgent, name: "Assistant", proactiveGreetingEnabled: true, assistantDefaultLocale: "it" },
    })).resolves.toMatchObject({ answer: "Ciao!" });

    expect(chatGateway.answer).toHaveBeenCalledOnce();
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
      },
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
      chatGateway,
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

describe("chat bootstrap service — exact greeting", () => {
  const setUpWorkspace = async (overrides?: { proactiveGreetingEnabled?: boolean; assistantDefaultLocale?: string }) => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
      assistantName: "Marta",
      greetingInstruction: "",
      assistantDefaultLocale: overrides?.assistantDefaultLocale ?? "en",
      proactiveGreetingEnabled: overrides?.proactiveGreetingEnabled ?? true,
    });
    return { workspaceRepository, workspace };
  };

  it("skips usage reservation and the model call, but still writes a delivery record", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const saveSpy = vi.spyOn(bootstrapGreetingCacheRepository, "save");
    const chatGateway = { answer: vi.fn(), streamAnswer: vi.fn() };
    const usageLimitPolicy = createUsageLimitPolicy();
    const revision = buildRevision({ exactWordsEnabled: true, exactContent: buildExactContent() });
    const agentRevisionRuntimeResolver = createAgentRevisionRuntimeResolver(revision);
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      chatGateway,
      createAuditService(),
      usageLimitPolicy,
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      agentRevisionRuntimeResolver,
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(result?.answer).toBe("Hello from the exact greeting.");
    expect(result?.bootstrapGreetingId).toEqual(expect.any(String));
    expect(chatGateway.answer).not.toHaveBeenCalled();
    expect(usageLimitPolicy.reserveAnswer).not.toHaveBeenCalled();
    // Exact content is never memoized to avoid an LLM call (there is none to avoid);
    // this write is the delivery record of what the visitor was actually shown, kept
    // so first-turn promotion can carry the same text and chips into history.
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the same delivery record row across repeated bootstraps for the same revision and locale", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const saveSpy = vi.spyOn(bootstrapGreetingCacheRepository, "save");
    const revision = buildRevision({ exactWordsEnabled: true, exactContent: buildExactContent() });
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      { answer: vi.fn(), streamAnswer: vi.fn() },
      createAuditService(),
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      createAgentRevisionRuntimeResolver(revision),
    );

    const first = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });
    const second = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(second?.bootstrapGreetingId).toBe(first?.bootstrapGreetingId);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers the resolved variant with chips carrying stable ids", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const revision = buildRevision({
      exactWordsEnabled: true,
      exactContent: buildExactContent({
        chips: ["book", "pricing"],
        variants: [{ locale: "en", body: "Hi there.", chipLabels: { book: "Book now", pricing: "See pricing" } }],
      }),
    });
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      { answer: vi.fn(), streamAnswer: vi.fn() },
      createAuditService(),
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      createAgentRevisionRuntimeResolver(revision),
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(result?.answer).toBe("Hi there.");
    expect(result?.citations).toEqual([]);
    expect(result?.suggestions).toEqual([
      { id: "book", text: "Book now", kind: "authored", action: { kind: "ask_followup" } },
      { id: "pricing", text: "See pricing", kind: "authored", action: { kind: "ask_followup" } },
    ]);

    // The delivery record (not an LLM cache) carries the same chips, so
    // `chatSessionPreparer.promoteBootstrapGreeting` can copy them into history.
    const record = await bootstrapGreetingCacheRepository.findById(workspace.id, result!.bootstrapGreetingId!);
    expect(record?.suggestions).toEqual([
      { id: "book", text: "Book now", kind: "authored", action: { kind: "ask_followup" } },
      { id: "pricing", text: "See pricing", kind: "authored", action: { kind: "ask_followup" } },
    ]);
  });

  it("falls back from a regional tag to the base language and reports fallbackApplied", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const revision = buildRevision({
      exactWordsEnabled: true,
      exactContent: buildExactContent({ variants: [{ locale: "en", body: "Hello (en).", chipLabels: {} }] }),
    });
    const auditService = createAuditService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      { answer: vi.fn(), streamAnswer: vi.fn() },
      auditService,
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      createAgentRevisionRuntimeResolver(revision),
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en-US" });

    expect(result?.answer).toBe("Hello (en).");
    expect(auditService.events[0]?.metadata).toMatchObject({
      greetingMode: "exact",
      requestedLocale: "en-US",
      resolvedLocale: "en",
      fallbackApplied: true,
    });
  });

  it("falls back to the agent default locale when no requested-language variant exists", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace({ assistantDefaultLocale: "en" });
    const revision = buildRevision({
      exactWordsEnabled: true,
      exactContent: buildExactContent({ variants: [{ locale: "en", body: "Hello (default).", chipLabels: {} }] }),
    });
    const auditService = createAuditService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      { answer: vi.fn(), streamAnswer: vi.fn() },
      auditService,
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      createAgentRevisionRuntimeResolver(revision),
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "fr-FR" });

    expect(result?.answer).toBe("Hello (default).");
    expect(auditService.events[0]?.metadata).toMatchObject({
      greetingMode: "exact",
      requestedLocale: "fr-FR",
      resolvedLocale: "en",
      fallbackApplied: true,
    });
  });

  it("returns the channel's unavailable state when no variant resolves, with no synthetic greeting or chips", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace({ assistantDefaultLocale: "en" });
    // A revision whose only variant is neither the request nor the agent default locale
    // cannot pass release validation in the real system (FR-005 requires a default-locale
    // variant), but a stale/legacy snapshot is exactly the case FR-011 exists for.
    const revision = buildRevision({
      exactWordsEnabled: true,
      exactContent: buildExactContent({ variants: [{ locale: "fr", body: "Bonjour.", chipLabels: {} }] }),
    });
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const saveSpy = vi.spyOn(bootstrapGreetingCacheRepository, "save");
    const auditService = createAuditService();
    const service = new ChatBootstrapService(
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      { answer: vi.fn(), streamAnswer: vi.fn() },
      auditService,
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      createAgentRevisionRuntimeResolver(revision),
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "de" });

    expect(result).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(auditService.events[0]).toMatchObject({ eventStatus: "failure" });
    expect(auditService.events[0]?.metadata).toMatchObject({
      greetingMode: "exact",
      requestedLocale: "de",
      reasonCode: "missing_variant",
    });
  });

  it("keeps proactiveGreetingEnabled=false as an off switch even when exact content is authored", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace({ proactiveGreetingEnabled: false });
    const revision = buildRevision({ exactWordsEnabled: true, exactContent: buildExactContent() });
    const agentRevisionRuntimeResolver = createAgentRevisionRuntimeResolver(revision);
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      { answer: vi.fn(), streamAnswer: vi.fn() },
      createAuditService(),
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      agentRevisionRuntimeResolver,
    );

    const result = await service.startConversation({ workspaceId: workspace.id });

    expect(result).toBeNull();
    expect(agentRevisionRuntimeResolver.resolveNew).not.toHaveBeenCalled();
  });

  it("uses the pinned candidate revision, not the published lookup, for a trusted test-execution bootstrap", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const agentService = createAgentService(workspaceRepository);
    const defaultAgent = await agentService.resolve(workspace.id);
    const revision = buildRevision({
      exactWordsEnabled: true,
      exactContent: buildExactContent({ variants: [{ locale: "en", body: "Pinned candidate greeting.", chipLabels: {} }] }),
    });
    const agentRevisionRuntimeResolver = createAgentRevisionRuntimeResolver(revision);
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      { answer: vi.fn(), streamAnswer: vi.fn() },
      createAuditService(),
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      agentService,
      agentRevisionRuntimeResolver,
    );

    const result = await service.startConversation({
      workspaceId: workspace.id,
      revisionId: revision.id,
      agentOverride: { ...defaultAgent, name: "Assistant", proactiveGreetingEnabled: true },
    });

    expect(result?.answer).toBe("Pinned candidate greeting.");
    expect(agentRevisionRuntimeResolver.resolvePinned).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: revision.id, allowCandidate: true }),
    );
    expect(agentRevisionRuntimeResolver.resolveNew).not.toHaveBeenCalled();
  });

  it("falls through to Automatic when the agent has never published a revision", async () => {
    const { workspaceRepository, workspace } = await setUpWorkspace();
    const chatGateway = { answer: vi.fn(async () => "Automatic greeting."), streamAnswer: vi.fn() };
    const agentRevisionRuntimeResolver = createAgentRevisionRuntimeResolver(null);
    const service = new ChatBootstrapService(
      workspaceRepository,
      new InMemoryBootstrapGreetingCacheRepository(),
      chatGateway,
      createAuditService(),
      createUsageLimitPolicy(),
      createProductAnalyticsService(),
      createAgentService(workspaceRepository),
      agentRevisionRuntimeResolver,
    );

    const result = await service.startConversation({ workspaceId: workspace.id, userExpectedLocale: "en" });

    expect(result?.answer).toBe("Automatic greeting.");
    expect(chatGateway.answer).toHaveBeenCalledOnce();
  });
});
