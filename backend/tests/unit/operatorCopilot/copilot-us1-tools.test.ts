import { describe, expect, it, vi } from "vitest";

import { validateAgentInput } from "../../../src/modules/agents/public.js";
import { builtInAnswerDirectiveViews } from "../../../src/modules/directives/public.js";
import { createUs1CopilotTools } from "../../../src/modules/operatorCopilot/tools.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

const pageContext = (agentId: string | null) => ({
  view: "agent" as const,
  agentId,
  conversationId: null,
  selection: null,
  entities: [],
});

const context = (agentId: string | null) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: pageContext(agentId),
});

const routine = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lineageId: "33333333-3333-4333-8333-333333333333",
  version: 1,
  status: "draft",
  name: "support-intake",
  activation: {
    triggerDescription: "When the user needs support",
    gateRef: null,
    priority: 7,
    reentryMode: "always",
  },
  slots: [],
  steps: [{
    stableStepId: "collect_topic",
    kind: "chat",
    instruction: "Ask how we can help.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: { outlineLabel: "collect_topic" },
  }],
  transitions: [{
    fromStep: "collect_topic",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

const authoredDirective = (overrides: Record<string, unknown> = {}) => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Do not guess",
  condition: { kind: "always" as const },
  action: "Say when the available evidence is insufficient.",
  priority: 100,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  routes: [],
  tags: [],
  description: null,
  binding: null,
  lifecycle: null,
  metadata: {},
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

const resolvedAgent = (directives = [authoredDirective()]) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "workspace-1",
  ...validateAgentInput({
    name: "Support",
    customInstruction: "Answer from the workspace knowledge base.",
    surfaceSettings: {
      anonymousChat: { enabled: true, token: "raw-anonymous-token" },
      websiteEmbed: {
        enabled: true,
        token: "raw-embed-token",
        allowedOrigins: ["https://private.example.com"],
      },
    },
  }),
  authoredDirectives: directives,
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
});

const dependencies = (routineDefinitions: RoutineDefinition[] = [
  routine(),
  routine({ id: "22222222-2222-4222-8222-222222222222", name: "book-a-demo" }),
], agent = resolvedAgent()) => {
  const listAgents = vi.fn(async () => [{
    id: agent.id,
    name: agent.name,
    isDefault: true,
    assistantBootstrapActive: false,
    customInstruction: "must not leak through the summary",
  }] as never);
  const resolveAgent = vi.fn(async () => agent);
  const listRoutines = vi.fn(async () => routineDefinitions);
  const getRoutine = vi.fn(async (_workspaceId: string, _agentId: string, routineId: string) =>
    routineDefinitions.find((definition) => definition.id === routineId) ?? routine({ id: routineId }));
  const getConversation = vi.fn();
  const getConversationTurn = vi.fn();
  const listConversations = vi.fn();
  return {
    listAgents,
    resolveAgent,
    listRoutines,
    getRoutine,
    getConversation,
    getConversationTurn,
    listConversations,
    descriptors: createUs1CopilotTools({
      agentService: { listExisting: listAgents, resolve: resolveAgent },
      routineDefinitionService: { list: listRoutines, get: getRoutine },
      chatHistoryService: { getConversation, getConversationTurn, listConversations },
      documentSearchService: { search: vi.fn() },
    }),
  };
};

describe("US1 copilot family readers", () => {
  it("classifies every family reader as a read", () => {
    expect(dependencies().descriptors.map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: "agent_configuration", shape: "read" },
      { name: "routine_definition", shape: "read" },
      { name: "conversation_transcript", shape: "read" },
      { name: "turn_trace", shape: "read" },
      { name: "conversation_history_search", shape: "read" },
      { name: "document_search", shape: "read" },
    ]);
  });

  it("reads a message-scoped trace for an unanswered user turn, including its failure reason", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "turn_trace")!;
    const history = (tool.createTool(context(null)) as { invoke: (input: { messageId: string }, options: unknown) => Promise<unknown> });
    const messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    // The port result deliberately models the missing assistant message: the diagnostic
    // belongs to the user turn and is the reason this tool is message-scoped.
    ports.getConversationTurn.mockResolvedValue({
      conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ownership: null,
      message: {
        id: messageId,
        role: "user",
        source: "customer",
        content: "Why did this not get an answer?",
        createdAt: "2026-08-18T10:00:00.000Z",
        turnFailure: {
          eventStatus: "failure",
          recordedAt: "2026-08-18T10:00:01.000Z",
          stream: true,
          errorMessage: "Provider request timed out",
        },
      },
    });

    const result = await history.invoke({ messageId }, {});
    expect(result).toMatchObject({
      trace: {
        conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        message: {
          id: messageId,
          turnFailure: { errorMessage: "Provider request timed out" },
        },
      },
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(ports.getConversationTurn).toHaveBeenCalledWith("workspace-1", messageId, {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeTurnFailureDebug: true,
    });
  });

  it("returns a shallow transcript with feedback and ownership enabled", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "conversation_transcript")!;
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    ports.getConversation.mockResolvedValue({
      conversationId,
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Support",
      sourceChannel: "website_embed",
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:02.000Z",
      messageCount: 1,
      ownership: {
        conversationId,
        state: "human_owned",
        ownerDisplayName: "Operator One",
        reason: "retrieval_miss",
        takenOverAt: "2026-08-18T10:00:01.000Z",
      },
      messages: [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        role: "assistant",
        source: "ai_agent",
        content: "Here is the answer.",
        createdAt: "2026-08-18T10:00:02.000Z",
        answerFeedbackEntries: [{ kind: "thumbs_down" }],
        latencyMs: 125,
        debug: {
          eventStatus: "success",
          recordedAt: "2026-08-18T10:00:02.000Z",
          stream: true,
          citationCount: 2,
          answerOutcome: "retrieval.answer",
          skillName: "retrieval.answer",
          skillOutcome: "answered",
          skillStatus: "completed",
          route: { generator: "assistant", routeType: "retrieval", routeReason: "grounded", retrievalInvoked: true },
          turnTrace: { private: "must not appear in a transcript" },
        },
      }],
    });

    const result = await tool.createTool(context(null)).invoke({ conversationId }, {} as never) as {
      transcript: { messages: Array<Record<string, unknown>> };
    };

    expect(ports.getConversation).toHaveBeenCalledWith("workspace-1", conversationId, { limit: 100 }, {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeTurnFailureDebug: true,
    });
    expect(result.transcript.messages[0]).toMatchObject({
      answerOutcome: "retrieval.answer",
      citationCount: 2,
      latencyMs: 125,
      answerFeedback: [{ kind: "thumbs_down" }],
    });
    expect(result.transcript.messages[0]).not.toHaveProperty("debug");
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("lists bounded safe agent summaries without creating or resolving an agent", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context(null)).invoke({ mode: "list" }, {} as never);

    expect(ports.listAgents).toHaveBeenCalledWith("workspace-1");
    expect(ports.resolveAgent).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "list",
      agentCount: 1,
      agentsTruncated: false,
      agents: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Support", isDefault: true, assistantBootstrapActive: false }],
      agent: null,
    });
    expect(JSON.stringify(result)).not.toContain("must not leak");
    expect(tool.describeEntity?.({}, context(null))).toBeNull();
  });

  it("allows explicit discovery even when page context selects an agent", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ mode: "list" }, {} as never);

    expect(result).toMatchObject({ mode: "list", agentCount: 1, agent: null });
    expect(ports.listAgents).toHaveBeenCalledOnce();
    expect(ports.resolveAgent).not.toHaveBeenCalled();
    expect(tool.describeEntity?.({ mode: "list" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toBeNull();
  });

  it("bounds agent discovery with explicit counts and truncation metadata", async () => {
    const ports = dependencies();
    ports.listAgents.mockResolvedValue(Array.from({ length: 41 }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      name: `Agent ${index}`,
      isDefault: index === 0,
      assistantBootstrapActive: false,
    })) as never);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context(null)).invoke({ mode: "list" }, {} as never) as { agents: unknown[]; agentCount: number; agentsTruncated: boolean };

    expect(result.agents).toHaveLength(40);
    expect(result.agentCount).toBe(41);
    expect(result.agentsTruncated).toBe(true);
  });

  it("returns only the selected agent with redacted config and directive identities", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
      agent: Record<string, unknown>;
    };
    const serialized = JSON.stringify(result);

    expect(ports.resolveAgent).toHaveBeenCalledWith("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(ports.listAgents).not.toHaveBeenCalled();
    expect(result.agent).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      schemaVersion: 3,
      directiveCount: 1,
      directivesTruncated: false,
      directiveRefs: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Do not guess" }],
      directive: null,
      builtInDirectiveCount: builtInAnswerDirectiveViews.length,
      builtInsTruncated: false,
      builtIns: builtInAnswerDirectiveViews.map((directive) => ({
        ...directive,
        actionChars: directive.action.length,
        omittedReason: null,
      })),
      surfaceSettings: {
        anonymousChat: { token: { __redacted: "secret" } },
        websiteEmbed: {
          token: { __redacted: "secret" },
          allowedOrigins: [{ __ref: "websiteEmbedAllowedOrigin" }],
        },
      },
    });
    expect(serialized).not.toContain("raw-anonymous-token");
    expect(serialized).not.toContain("raw-embed-token");
    expect(serialized).not.toContain("https://private.example.com");
  });

  it("reports directive bounds and retrieves a selected long directive without truncating its action", async () => {
    const longAction = "Evidence ".repeat(440).trim();
    const directives = Array.from({ length: 41 }, (_, index) => authoredDirective({
      id: `${String(index).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      name: `Directive ${index}`,
      action: index === 40 ? longAction : `Action ${index}`,
      requiredCapabilities: index === 40
        ? Array.from({ length: 11 }, (_, capabilityIndex) => `capability-${capabilityIndex}-${"x".repeat(180)}`)
        : [],
      metadata: index === 40 ? { oversized: "m".repeat(5_000) } : {},
    }));
    const selectedDirective = directives[40]!;
    const ports = dependencies(undefined, resolvedAgent(directives));
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({
      mode: "detail",
      directiveId: selectedDirective.id,
    }, {} as never) as { agent: Record<string, unknown> };

    expect(result).toMatchObject({
      mode: "detail",
      agentCount: null,
      agentsTruncated: null,
      agent: {
        directiveCount: 41,
        directivesTruncated: true,
        directiveRefs: expect.arrayContaining([{ id: selectedDirective.id, name: "Directive 40" }]),
        directive: {
          id: selectedDirective.id,
          name: "Directive 40",
          action: longAction,
          requiredCapabilities: expect.any(Array),
          metadata: null,
          detailBounds: {
            metadataOmittedReason: "content_too_large",
            truncatedCollections: ["requiredCapabilities"],
          },
        },
      },
    });
    expect((result.agent.directiveRefs as unknown[])).toHaveLength(40);
    expect(((result.agent.directive as { requiredCapabilities: unknown[] }).requiredCapabilities)).toHaveLength(10);
    expect(JSON.stringify(result)).toContain(longAction);
    expect(JSON.stringify(result)).not.toContain("mmm");
  });

  it("prefers an explicit agent id over page context", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, {} as never);

    expect(ports.resolveAgent).toHaveBeenCalledWith("workspace-1", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("lists routine identities and portability metadata without duplicating content", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as Record<string, unknown>;

    expect(ports.listRoutines).toHaveBeenCalledWith("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(ports.getRoutine).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      routineCount: 2,
      routinesTruncated: false,
      routine: null,
      routines: [
        { id: "11111111-1111-4111-8111-111111111111", name: "support-intake", status: "draft", portable: { ok: true, grammarVersion: 1 } },
        { id: "22222222-2222-4222-8222-222222222222", name: "book-a-demo", status: "draft", portable: { ok: true, grammarVersion: 1 } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Ask how we can help");
  });

  it("reads one routine with its stable identity and complete portable content", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: "11111111-1111-4111-8111-111111111111" }, {} as never);

    expect(result).toMatchObject({
      routine: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "support-intake",
        status: "draft",
        portable: { ok: true, grammarVersion: 1, omittedReason: null },
      },
      routines: [],
    });
    expect(JSON.stringify(result)).toContain("Ask how we can help");
    expect(ports.listRoutines).not.toHaveBeenCalled();
  });

  it("reports nonportable routines without failing discovery or detail", async () => {
    const unsupported = routine({
      id: "44444444-4444-4444-8444-444444444444",
      name: "gated-routine",
      activation: { triggerDescription: "Gated", gateRef: "existing-gate", priority: 0, reentryMode: "always" },
    });
    const ports = dependencies([routine(), unsupported]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const listed = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never);
    const detailed = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: unsupported.id }, {} as never);

    expect(listed).toMatchObject({ routines: [{ portable: { ok: true } }, { id: unsupported.id, portable: { ok: false } }] });
    expect(detailed).toMatchObject({ routine: { id: unsupported.id, portable: { ok: false } } });
  });

  it("bounds routine discovery with explicit counts and truncation metadata", async () => {
    const routines = Array.from({ length: 41 }, (_, index) => routine({
      id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `routine-${index}`,
    }));
    const ports = dependencies(routines);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as { routines: unknown[]; routineCount: number; routinesTruncated: boolean };

    expect(result.routines).toHaveLength(40);
    expect(result.routineCount).toBe(41);
    expect(result.routinesTruncated).toBe(true);
  });

  it("omits oversized routine content instead of returning corrupted markdown", async () => {
    const oversized = routine({
      steps: [{
        stableStepId: "collect_topic",
        kind: "chat",
        instruction: "x".repeat(20_001),
        toolRef: null,
        actionType: null,
        ordinal: 0,
        metadata: { outlineLabel: "collect_topic" },
      }],
    });
    const ports = dependencies([oversized]);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "routine_definition")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ routineId: oversized.id }, {} as never);

    expect(result).toMatchObject({
      routine: { portable: { ok: true, content: null, omittedReason: "content_too_large" } },
    });
    expect(JSON.stringify(result)).not.toContain("xxx");
  });
});
