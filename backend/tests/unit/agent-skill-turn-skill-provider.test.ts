import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SkillInvocation } from "../../src/modules/skills/public.js";
import {
  SkillExecutorRegistry,
  type SkillDispatchResult,
  type SkillExecutorPort,
} from "../../src/modules/skills/public.js";
import type { AgentSkillRepositoryPort, AgentSkillSpine } from "../../src/modules/agentSkills/public.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../src/app/composition/builtIn/agentSkillTurnSkillProvider.js";
import { DefaultAllowCapabilityPolicy, type CapabilityCheckInput, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnSelectionStrategy } from "../../src/modules/chat/services/turnSelectionStrategy.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../src/modules/retrieval/public.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/services/retrievalPipelineService.js";

const workspaceId = randomUUID();
const agentId = randomUUID();
const conversationId = randomUUID();

const agentSkill = (overrides: Partial<AgentSkillSpine> & Pick<AgentSkillSpine, "skillName">): AgentSkillSpine => {
  const now = new Date("2026-07-03T12:00:00.000Z");
  const { skillName, ...rest } = overrides;
  return {
    id: randomUUID(),
    workspaceId,
    agentId,
    skillName,
    kind: "external_mcp",
    invocationMode: "agent_selectable",
    enabled: true,
    targetType: "mcp_connection",
    targetId: randomUUID(),
    config: {},
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
};

const repositoryWith = (
  skills: AgentSkillSpine[],
): Pick<AgentSkillRepositoryPort, "listByAgent"> => ({
  listByAgent: vi.fn(async () => skills),
});

const sessionWithBinding = (skillName: string): PreparedSession =>
  ({
    agent: {
      id: agentId,
      workspaceId,
      name: "Support agent",
      customInstruction: "",
      assistantDefaultLocale: null,
      chatModelOverride: null,
      retrievalEnabled: true,
      skillSettings: {},
      contactRequestsEnabled: false,
      contactRequestDelivery: { recipientEmails: [], webhook: null },
      webhookExportsEnabled: false,
    },
    conversation: { id: conversationId, workspaceId },
    history: [],
    userMessage: { id: randomUUID(), content: "Where is order 123?" },
    effectiveQuery: "Where is order 123?",
    pageContext: null,
    resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
    stagedContext: [],
    turnTrace: { events: [] },
    directiveSteering: {
      rules: [{ action: "Look up the order.", source: "directive", lifespan: "response" }],
      omissions: [],
      matches: [{
        directive: {
          name: "order-status",
          condition: { kind: "always" },
          action: "Look up the order.",
          binding: { kind: "skill", skillName },
        },
        selectionMode: "deterministic",
        selectionReason: "always",
      }],
    },
  }) as unknown as PreparedSession;

const defaultTurnSkill: TurnSkill = {
  definition: { name: "retrieval.answer", outcomeKinds: ["retrieval"] },
  selects: () => true,
  dispatch: () => {
    throw new Error("default dispatch not used");
  },
  renderer: {
    supports: () => false,
    render: async () => {
      throw new Error("default render not used");
    },
  },
};

const strategy: TurnSelectionStrategy = {
  select: () => ["retrieval"],
};

const retrievalResult = (): RetrievalPipelineResult => ({
  rewrittenQuery: "refund policy",
  systemPrompt: "system",
  prompt: "prompt",
  citations: [],
  responseIdentity: null,
  responseSettings: {
    citationDisplayEnabled: true,
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
  },
  diagnostics: {
    rewriteStatus: "applied",
    rerankStatus: "applied",
    originalCandidateCount: 1,
    rewrittenCandidateCount: 1,
    normalizedCandidateCount: 1,
    finalContextCount: 1,
    candidateFallbackApplied: false,
    fallbackApplied: false,
  },
  trace: {
    traceId: "retrieval-trace",
    startedAt: "2026-07-03T12:00:00.000Z",
    stages: [],
    links: [],
  },
  contexts: [{
    chunkId: "chunk-refund",
    documentId: "doc-refund",
    title: "Refund policy",
    content: "Refunds are available within thirty days when the receipt is present.",
    searchText: "Refund policy receipt required.",
    similarity: 0.8,
    retrievalSources: ["semantic_rewritten"],
    retrievalText: "Refunds are available within thirty days when the receipt is present.",
    semanticScore: 0.8,
    lexicalScore: 0,
    relevanceScore: 0.92,
    rerankPosition: 0,
    promptPosition: 0,
    estimatedTokenCost: 16,
    metadata: { category: "policy" },
  }],
});

describe("RepositoryAgentSkillTurnSkillProvider", () => {
  it("registers enabled agent-selectable skills for directive binding selection and dispatch", async () => {
    let invocation: SkillInvocation | undefined;
    const executor: SkillExecutorPort = {
      async dispatch(nextInvocation): Promise<SkillDispatchResult> {
        invocation = nextInvocation;
        return { disposition: "settled", outcome: { status: "completed", answer: "Order 123 is in transit." } };
      },
    };
    const registry = new SkillExecutorRegistry([
      { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, executor },
    ]);
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: repositoryWith([
        agentSkill({ skillName: "order_lookup" }),
        agentSkill({ skillName: "disabled_lookup", enabled: false }),
        agentSkill({ skillName: "routine_lookup", invocationMode: "routine_named" }),
      ]),
      executorRegistry: registry,
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
    });
    const session = sessionWithBinding("order_lookup");

    const runtime = await provider.forSession(session);
    const selector = new ChatTurnSkillSelector(
      [defaultTurnSkill, ...runtime.turnSkills],
      strategy,
      { agentSkillStates: runtime.skillStates },
    );

    const selected = selector.select(session);
    expect(selected.skill.definition.name).toBe("order_lookup");
    expect(selected.decision.reason).toBe("directive:order-status");
    expect(runtime.skillStates.get("disabled_lookup")).toEqual({ enabled: false, turnCapable: true, stagingCapable: false });
    expect(runtime.skillStates.get("routine_lookup")).toEqual({ enabled: true, turnCapable: false, stagingCapable: false });

    const outcome = await selected.skill.dispatch(session);
    expect(outcome).toMatchObject({
      kind: "agent_skill",
      skillName: "order_lookup",
      outcome: { status: "completed", answer: "Order 123 is in transit." },
    });
    expect(invocation).toMatchObject({
      skill: { name: "order_lookup" },
      collected: {
        query: "Where is order 123?",
        message: "Where is order 123?",
      },
      context: {
        workspaceId,
        agentId,
        sessionId: conversationId,
        conversationId,
      },
    });
    expect((invocation?.skill as { requiredCapabilities?: string[] }).requiredCapabilities).toEqual(["external_skills.invoke"]);
  });

  it("checks cancellation immediately before external skill dispatch", async () => {
    const dispatch = vi.fn(async (): Promise<SkillDispatchResult> => ({
      disposition: "settled",
      outcome: { status: "completed", answer: "stale answer" },
    }));
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: repositoryWith([agentSkill({ skillName: "order_lookup" })]),
      executorRegistry: new SkillExecutorRegistry([{
        kind: "internal",
        adapter: EXTERNAL_SKILLS_ADAPTER,
        executor: { dispatch },
      }]),
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
    });
    const session = sessionWithBinding("order_lookup");
    const throwIfCancelled = vi.fn(() => {
      throw new ChatTurnSupersededError(conversationId, "rendering");
    });
    const runtime = await provider.forSession(session, { throwIfCancelled });
    const selector = new ChatTurnSkillSelector(
      [defaultTurnSkill, ...runtime.turnSkills],
      strategy,
      { agentSkillStates: runtime.skillStates },
    );

    await expect(selector.select(session).skill.dispatch(session)).rejects.toBeInstanceOf(ChatTurnSupersededError);
    expect(throwIfCancelled).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("excludes skill kinds whose executors cannot produce a user-facing terminal answer", async () => {
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: repositoryWith([
        agentSkill({ skillName: "grounded_search", kind: "retrieve", targetType: null, targetId: null }),
        agentSkill({ skillName: "crm_webhook", kind: "webhook" }),
        agentSkill({ skillName: "escalate", kind: "slack" }),
      ]),
      executorRegistry: new SkillExecutorRegistry([]),
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
    });

    const runtime = await provider.forSession(sessionWithBinding("grounded_search"));

    expect(runtime.turnSkills).toEqual([]);
    expect(runtime.skillStates.get("grounded_search")).toEqual({ enabled: true, turnCapable: false, stagingCapable: true });
    expect(runtime.skillStates.get("crm_webhook")).toEqual({ enabled: true, turnCapable: false, stagingCapable: false });
    expect(runtime.skillStates.get("escalate")).toEqual({ enabled: true, turnCapable: false, stagingCapable: false });
  });

  it("stages matched retrieve bindings as agentic retrieval tools and records returned contexts", async () => {
    const run = vi.fn(async () => retrievalResult());
    const registry = new SkillExecutorRegistry([
      {
        kind: "internal",
        adapter: RETRIEVAL_ANSWER_ADAPTER,
        executor: new RetrievalAnswerSkillExecutor({
          run,
          interpret: vi.fn(),
          runInterpreted: vi.fn(),
          runWithoutRetrieval: vi.fn(),
        }),
      },
    ]);
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: repositoryWith([
        agentSkill({ skillName: "grounded_search", kind: "retrieve", targetType: null, targetId: null, config: { sourceScope: "all" } }),
      ]),
      executorRegistry: registry,
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
    });
    const session = sessionWithBinding("grounded_search");

    const runtime = await provider.forSession(session);
    const chunkRegistry = {
      record: vi.fn(),
      resolve: vi.fn(),
      has: vi.fn(),
    };
    const tools = runtime.agenticRetrievalToolFactories(session).flatMap((factory) =>
      factory({ registry: chunkRegistry, snippetChars: 48 })
    );

    expect(tools.map((tool) => tool.name)).toEqual(["skill_grounded_search"]);
    const output = await tools[0]!.invoke(
      { query: "What is the refund policy?" },
      { signal: new AbortController().signal, stepIndex: 0, callId: "call-1" },
    );

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      query: "What is the refund policy?",
      workspaceId,
    }));
    expect(chunkRegistry.record).toHaveBeenCalledWith([
      expect.objectContaining({
        chunkId: "chunk-refund",
        fullContent: "Refunds are available within thirty days when the receipt is present.",
      }),
    ]);
    expect(output).toMatchObject({
      ok: true,
      skillName: "grounded_search",
      results: [expect.objectContaining({
        chunkId: "chunk-refund",
        title: "Refund policy",
      })],
    });
  });

  it("does not register bindable skills whose required capability the workspace denies", async () => {
    const checks: CapabilityCheckInput[] = [];
    const denyExternalSkills: CapabilityPolicy = {
      async can(input) {
        checks.push(input);
        return { allowed: input.capability !== "external_skills.invoke" };
      },
    };
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: repositoryWith([agentSkill({ skillName: "order_lookup" })]),
      executorRegistry: new SkillExecutorRegistry([]),
      capabilityPolicy: denyExternalSkills,
    });

    const runtime = await provider.forSession(sessionWithBinding("order_lookup"));

    expect(runtime.turnSkills).toEqual([]);
    expect(runtime.skillStates.get("order_lookup")).toEqual({
      enabled: true,
      turnCapable: true,
      stagingCapable: false,
      capabilityDenied: true,
    });
    expect(checks).toEqual([{ capability: "external_skills.invoke", workspaceId }]);
  });
});
