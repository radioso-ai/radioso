import type { SkillDefinition } from "@radioso/skill-contract";

import type { AgentSkillRepositoryPort } from "../../../modules/agentSkills/public.js";
import type { AgentSkillKind, AgentSkillSpine } from "../../../modules/agentSkills/public.js";
import {
  buildPreparedTurnOutcome,
  GenericTurnOutcomeRenderer,
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
  type AgentSkillTurnRuntime,
  type AgentSkillTurnSkillProvider,
  type PreparedSession,
  type TurnOutcome,
  type TurnSkill,
} from "../../../modules/chat/composition.js";
import {
  noopSkillEmitPort,
  type SkillExecution,
  type SkillExecutorRegistry,
} from "../../../modules/skills/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER } from "../../../modules/customerEmail/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../../modules/webhookSkills/public.js";
import { SLACK_SKILLS_ADAPTER } from "../../../modules/slackSkills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER } from "../../../modules/retrieval/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";

export interface RepositoryAgentSkillTurnSkillProviderOptions {
  agentSkills: Pick<AgentSkillRepositoryPort, "listByAgent">;
  executorRegistry: SkillExecutorRegistry;
}

const AGENT_SKILL_OUTCOME_KIND = "agent_skill";

type RuntimeSkillDefinition = SkillDefinition & {
  metadata?: Record<string, unknown>;
};

const outcomeFor = (
  session: PreparedSession,
  skillName: string,
  outcome: TurnOutcome["outcome"],
): TurnOutcome => ({
  ...buildPreparedTurnOutcome(session, { kind: AGENT_SKILL_OUTCOME_KIND, skillName }),
  outcome,
});

const settledFailure = (session: PreparedSession, skillName: string, reason: string): TurnOutcome =>
  outcomeFor(session, skillName, {
    status: "failed",
    outputs: { skill: skillName, reason },
  });

const collectedTurnInput = (session: PreparedSession): Record<string, unknown> => ({
  query: session.effectiveQuery,
  message: session.userMessage.content,
  pageContext: session.pageContext ?? null,
  context: session.resolvedContext.snapshot,
});

const executionFromConfig = (value: unknown): SkillExecution | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "internal" && typeof candidate.adapter === "string") {
    return {
      kind: "internal",
      adapter: candidate.adapter,
      ...(typeof candidate.enqueue === "boolean" ? { enqueue: candidate.enqueue } : {}),
    };
  }
  if (candidate.kind === "delivery_pipeline" && typeof candidate.adapter === "string") {
    return {
      kind: "delivery_pipeline",
      adapter: candidate.adapter,
      destinations: Array.isArray(candidate.destinations)
        ? candidate.destinations.filter((destination): destination is "email" | "webhook" =>
            destination === "email" || destination === "webhook")
        : [],
      enqueue: typeof candidate.enqueue === "boolean" ? candidate.enqueue : false,
    };
  }
  if (
    candidate.kind === "webhook" &&
    (candidate.provider === "make" || candidate.provider === "zapier" || candidate.provider === "custom") &&
    typeof candidate.endpointId === "string"
  ) {
    return {
      kind: "webhook",
      provider: candidate.provider,
      endpointId: candidate.endpointId,
      enqueue: typeof candidate.enqueue === "boolean" ? candidate.enqueue : false,
      ...(typeof candidate.timeoutMs === "number" ? { timeoutMs: candidate.timeoutMs } : {}),
    };
  }
  return null;
};

const executionForKind = (kind: AgentSkillKind): SkillExecution | undefined => {
  switch (kind) {
    case "external_mcp":
      return { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, enqueue: false };
    case "customer_email":
      return { kind: "internal", adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER, enqueue: false };
    case "webhook":
      return { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false };
    case "slack":
      return { kind: "internal", adapter: SLACK_SKILLS_ADAPTER, enqueue: false };
    case "retrieve":
      return { kind: "internal", adapter: RETRIEVAL_ANSWER_ADAPTER, enqueue: false };
    case "notify":
      return { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false };
  }
};

const runtimeSkillDefinitionForAgentSkill = (agentSkill: AgentSkillSpine): RuntimeSkillDefinition => ({
  name: agentSkill.skillName,
  displayName: agentSkill.skillName,
  description: "Agent-selectable skill routed through the skill executor registry.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: ["assistant"],
  requiredCapabilities: [],
  contractReferences: [],
  execution: executionFromConfig(agentSkill.config?.execution) ?? executionForKind(agentSkill.kind),
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
  metadata: {
    agentSkillId: agentSkill.id,
    agentSkillKind: agentSkill.kind,
    ...(agentSkill.kind === "retrieve" ? { retrieveConfig: agentSkill.config ?? {} } : {}),
  },
});

const turnSkillForAgentSkill = (
  agentSkill: AgentSkillSpine,
  executorRegistry: SkillExecutorRegistry,
): TurnSkill => {
  const skill = runtimeSkillDefinitionForAgentSkill(agentSkill);
  const renderer = new GenericTurnOutcomeRenderer();
  return {
    definition: { name: agentSkill.skillName, outcomeKinds: [AGENT_SKILL_OUTCOME_KIND] },
    selects: () => false,
    async dispatch(session) {
      if (!skill.execution) {
        return settledFailure(session, agentSkill.skillName, "no_execution");
      }
      const executor = executorRegistry.resolve(skill.execution);
      if (!executor) {
        return settledFailure(session, agentSkill.skillName, "no_executor");
      }
      const result = await executor.dispatch({
        skill,
        collected: collectedTurnInput(session),
        context: {
          workspaceId: session.agent.workspaceId,
          agentId: session.agent.id,
          sessionId: session.conversation.id,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          turn: {
            agent: toConversationAgentConfig(session.agent),
            sessionId: session.conversation.id,
            inputEvent: {
              ...toConversationInputEvent(session.userMessage),
              content: session.effectiveQuery,
            },
            history: toConversationMessages(session.history),
            stagedContext: session.stagedContext,
            steering: session.directiveSteering?.rules ?? [],
          },
        },
        emit: noopSkillEmitPort,
      }).catch(() => null);
      if (!result) {
        return settledFailure(session, agentSkill.skillName, "executor_error");
      }
      if (result.disposition !== "settled") {
        return settledFailure(session, agentSkill.skillName, "deferred");
      }
      return outcomeFor(session, agentSkill.skillName, result.outcome);
    },
    renderer,
  };
};

export class RepositoryAgentSkillTurnSkillProvider implements AgentSkillTurnSkillProvider {
  constructor(private readonly options: RepositoryAgentSkillTurnSkillProviderOptions) {}

  async forSession(session: PreparedSession): Promise<AgentSkillTurnRuntime> {
    const records = await this.options.agentSkills.listByAgent(session.agent.workspaceId, session.agent.id);
    const skillStates = new Map<string, { enabled: boolean; turnCapable: boolean }>();
    const turnSkills: TurnSkill[] = [];
    for (const record of records) {
      const turnCapable = record.invocationMode === "agent_selectable";
      skillStates.set(record.skillName, {
        enabled: record.enabled,
        turnCapable,
      });
      if (record.enabled && turnCapable) {
        turnSkills.push(turnSkillForAgentSkill(record, this.options.executorRegistry));
      }
    }
    return { turnSkills, skillStates };
  }
}
