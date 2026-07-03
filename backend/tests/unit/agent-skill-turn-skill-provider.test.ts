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
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnSelectionStrategy } from "../../src/modules/chat/services/turnSelectionStrategy.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../src/modules/externalSkills/executor/mcpSkillExecutor.js";

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
    expect(runtime.skillStates.get("disabled_lookup")).toEqual({ enabled: false, turnCapable: true });
    expect(runtime.skillStates.get("routine_lookup")).toEqual({ enabled: true, turnCapable: false });

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
  });
});
