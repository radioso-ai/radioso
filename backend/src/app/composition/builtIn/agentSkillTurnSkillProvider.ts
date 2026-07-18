import { z } from "zod";
import type { SkillDefinition } from "@radioso/skill-contract";

import type { AgentSkillRepositoryPort } from "../../../modules/agentSkills/public.js";
import type { AgentSkillKind, AgentSkillSpine } from "../../../modules/agentSkills/public.js";
import type { FinalPromptContext } from "../../../modules/retrieval/public.js";
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
import { capabilityNames, type CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER } from "../../../modules/customerEmail/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../../modules/webhookSkills/public.js";
import { SLACK_SKILLS_ADAPTER } from "../../../modules/slackSkills/public.js";
import {
  RETRIEVAL_ANSWER_ADAPTER,
  readRetrievalResult,
  type AgenticRetrievalToolFactory,
} from "../../../modules/retrieval/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";
import { buildSnippet, type RegisteredChunk } from "../../../modules/retrieval/public.js";

export interface RepositoryAgentSkillTurnSkillProviderOptions {
  agentSkills: Pick<AgentSkillRepositoryPort, "listByAgent">;
  executorRegistry: SkillExecutorRegistry;
  capabilityPolicy: CapabilityPolicy;
}

const AGENT_SKILL_OUTCOME_KIND = "agent_skill";

/**
 * Skill kinds a directive binding may claim a chat turn with. Only `external_mcp`
 * executors settle with user-facing answer text; `retrieve` deliberately returns
 * raw contexts (the chat turn loop owns answer composition — routing it through
 * the retrieval composer is the route-steering follow-up), and the action kinds
 * (webhook, slack, email, notify) settle with outputs only, which would render a
 * blank reply through the generic outcome renderer.
 */
const TURN_BINDABLE_KINDS: ReadonlySet<AgentSkillKind> = new Set(["external_mcp"]);
const AGENTIC_STAGEABLE_KINDS: ReadonlySet<AgentSkillKind> = new Set(["retrieve"]);
const STAGED_TOOL_NAME_PREFIX = "skill_";
const STAGED_TOOL_NAME_MAX_LENGTH = 64;

/**
 * The same per-kind capability requirements the routine dispatch path enforces
 * (each kind's routineSkillResolver); kept in sync so a workspace capability
 * denial gates directive-bound dispatch exactly like routine dispatch.
 */
const requiredCapabilitiesForKind = (kind: AgentSkillKind): string[] => {
  switch (kind) {
    case "retrieve":
      return [capabilityNames.retrieval.answer];
    case "external_mcp":
    case "customer_email":
    case "webhook":
    case "slack":
      return [capabilityNames.externalSkills.invoke];
    case "notify":
      return [];
  }
};

type RuntimeSkillDefinition = SkillDefinition & {
  metadata?: Record<string, unknown>;
};

const stagedToolInputSchema = z.object({
  query: z.string().trim().min(1).optional(),
}).strict();

const stagedToolOutputSchema = z.object({
  ok: z.boolean(),
  skillName: z.string(),
  directiveNames: z.array(z.string()),
  status: z.string().optional(),
  error: z.string().optional(),
  found: z.boolean().optional(),
  sourceCount: z.number().int().nonnegative().optional(),
  results: z.array(z.object({
    chunkId: z.string(),
    documentId: z.string(),
    title: z.string(),
    snippet: z.string(),
    score: z.number(),
  })).optional(),
});

type StagedToolInput = z.infer<typeof stagedToolInputSchema>;
type StagedToolOutput = z.infer<typeof stagedToolOutputSchema>;

const shortHash = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const stagedToolNameForSkill = (skillName: string): string => {
  const full = `${STAGED_TOOL_NAME_PREFIX}${skillName}`;
  if (full.length <= STAGED_TOOL_NAME_MAX_LENGTH) {
    return full;
  }
  const suffix = shortHash(skillName);
  const prefixLength = STAGED_TOOL_NAME_MAX_LENGTH - suffix.length - 1;
  return `${full.slice(0, prefixLength)}_${suffix}`;
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

const registeredChunkFromContext = (
  context: FinalPromptContext,
  snippetChars?: number,
): RegisteredChunk => ({
  chunkId: context.chunkId,
  documentId: context.documentId,
  title: context.title,
  snippet: buildSnippet(context, snippetChars),
  fullContent: context.content,
  similarity: context.relevanceScore,
  metadata: context.metadata,
  chunkIndex: context.chunkIndex,
  searchText: context.searchText,
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
  requiredCapabilities: requiredCapabilitiesForKind(agentSkill.kind),
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
  throwIfCancelled: () => void,
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
      throwIfCancelled();
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

const matchedDirectiveNamesForSkill = (session: PreparedSession, skillName: string): string[] =>
  [...new Set((session.directiveSteering?.matches ?? [])
    .filter((match) => match.directive.binding?.kind === "skill" && match.directive.binding.skillName === skillName)
    .map((match) => match.directive.name))];

const stagedToolFactoryForAgentSkill = (
  agentSkill: AgentSkillSpine,
  executorRegistry: SkillExecutorRegistry,
  session: PreparedSession,
  directiveNames: readonly string[],
  throwIfCancelled: () => void,
): AgenticRetrievalToolFactory => ({ registry, snippetChars }) => {
  const skill = runtimeSkillDefinitionForAgentSkill(agentSkill);
  const toolName = stagedToolNameForSkill(agentSkill.skillName);
  return [{
    name: toolName,
    description: [
      `Run the directive-staged lookup skill "${agentSkill.skillName}" and return workspace-grounded snippets.`,
      directiveNames.length > 0 ? `Matched directives: ${directiveNames.join(", ")}.` : "",
      "Use this when the current question needs this directive-specific lookup before finalizing evidence.",
    ].filter(Boolean).join(" "),
    inputSchema: stagedToolInputSchema,
    outputSchema: stagedToolOutputSchema,
    async invoke(input: StagedToolInput): Promise<StagedToolOutput> {
      if (!skill.execution) {
        return { ok: false, skillName: agentSkill.skillName, directiveNames: [...directiveNames], error: "no_execution" };
      }
      const executor = executorRegistry.resolve(skill.execution);
      if (!executor) {
        return { ok: false, skillName: agentSkill.skillName, directiveNames: [...directiveNames], error: "no_executor" };
      }
      const query = input.query?.trim() || session.effectiveQuery || session.userMessage.content;
      throwIfCancelled();
      const result = await executor.dispatch({
        skill,
        collected: {
          ...collectedTurnInput(session),
          query,
        },
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
              content: query,
            },
            history: toConversationMessages(session.history),
            stagedContext: session.stagedContext,
            steering: session.directiveSteering?.rules ?? [],
          },
        },
        emit: noopSkillEmitPort,
      }).catch(() => null);
      if (!result) {
        return { ok: false, skillName: agentSkill.skillName, directiveNames: [...directiveNames], error: "executor_error" };
      }
      if (result.disposition !== "settled") {
        return {
          ok: false,
          skillName: agentSkill.skillName,
          directiveNames: [...directiveNames],
          status: "deferred",
          error: "deferred",
        };
      }
      const retrieval = readRetrievalResult(result.outcome);
      if (!retrieval) {
        return {
          ok: false,
          skillName: agentSkill.skillName,
          directiveNames: [...directiveNames],
          status: result.outcome.status,
          error: "missing_retrieval_result",
        };
      }
      const registered = retrieval.contexts.map((context) => registeredChunkFromContext(context, snippetChars));
      registry.record(registered);
      return {
        ok: true,
        skillName: agentSkill.skillName,
        directiveNames: [...directiveNames],
        status: result.outcome.status,
        found: registered.length > 0,
        sourceCount: registered.length,
        results: registered.map((chunk) => ({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          title: chunk.title,
          snippet: chunk.snippet,
          score: chunk.similarity,
        })),
      };
    },
    estimatedResultTokens: () => 800,
  }];
};

export class RepositoryAgentSkillTurnSkillProvider implements AgentSkillTurnSkillProvider {
  constructor(private readonly options: RepositoryAgentSkillTurnSkillProviderOptions) {}

  async forSession(
    session: PreparedSession,
    coordination?: { throwIfCancelled(): void },
  ): Promise<AgentSkillTurnRuntime> {
    const throwIfCancelled = coordination?.throwIfCancelled ?? (() => undefined);
    const records = await this.options.agentSkills.listByAgent(session.agent.workspaceId, session.agent.id);
    const skillStates = new Map<string, { enabled: boolean; turnCapable: boolean; stagingCapable: boolean; capabilityDenied?: boolean }>();
    const turnSkills: TurnSkill[] = [];
    const stagedRecords: AgentSkillSpine[] = [];
    for (const record of records) {
      const turnCapable = record.invocationMode === "agent_selectable" && TURN_BINDABLE_KINDS.has(record.kind);
      const stagingCapable = record.invocationMode === "agent_selectable" && AGENTIC_STAGEABLE_KINDS.has(record.kind);
      if (!record.enabled || (!turnCapable && !stagingCapable)) {
        skillStates.set(record.skillName, { enabled: record.enabled, turnCapable, stagingCapable });
        continue;
      }
      const capabilityDenied = await this.firstCapabilityDenied(session.agent.workspaceId, record.kind);
      skillStates.set(record.skillName, {
        enabled: record.enabled,
        turnCapable,
        stagingCapable,
        ...(capabilityDenied ? { capabilityDenied } : {}),
      });
      if (!capabilityDenied && turnCapable) {
        turnSkills.push(turnSkillForAgentSkill(record, this.options.executorRegistry, throwIfCancelled));
      }
      if (!capabilityDenied && stagingCapable) {
        stagedRecords.push(record);
      }
    }
    return {
      turnSkills,
      skillStates,
      agenticRetrievalToolFactories: (currentSession) => stagedRecords.flatMap((record) => {
        const directiveNames = matchedDirectiveNamesForSkill(currentSession, record.skillName);
        return directiveNames.length > 0
          ? [stagedToolFactoryForAgentSkill(
              record,
              this.options.executorRegistry,
              currentSession,
              directiveNames,
              throwIfCancelled,
            )]
          : [];
      }),
    };
  }

  private async firstCapabilityDenied(workspaceId: string, kind: AgentSkillKind): Promise<boolean> {
    for (const capability of requiredCapabilitiesForKind(kind)) {
      try {
        const decision = await this.options.capabilityPolicy.can({ capability, workspaceId });
        if (!decision.allowed) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }
}
