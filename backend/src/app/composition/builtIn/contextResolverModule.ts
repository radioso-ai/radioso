import type { AgentSkillRepositoryPort } from "../../../modules/agentSkills/public.js";
import type { AgentSkillKind, AgentSkillSpine } from "../../../modules/agentSkills/public.js";
import type {
  ContextResolverPort,
  ContextVariableScope,
} from "../../../modules/context-variables/public.js";
import {
  noopSkillEmitPort,
  type SkillDefinition,
  type SkillDispatchResult,
  type SkillExecution,
  type SkillExecutorRegistry,
  type SkillOutcome,
} from "../../../modules/skills/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER } from "../../../modules/customerEmail/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../../modules/webhookSkills/public.js";
import { SLACK_SKILLS_ADAPTER } from "../../../modules/slackSkills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER } from "../../../modules/retrieval/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";

export interface SkillBackedContextResolverOptions {
  agentSkills: Pick<AgentSkillRepositoryPort, "findById">;
  skillExecutorRegistry: SkillExecutorRegistry;
}

export class SkillBackedContextResolver implements ContextResolverPort {
  constructor(private readonly options: SkillBackedContextResolverOptions) {}

  async resolve(input: {
    workspaceId: string;
    agentId: string;
    resolverSkillId: string;
    variableName: string;
    scope: ContextVariableScope;
    signal?: AbortSignal;
  }): Promise<{ value: unknown } | null> {
    const agentSkill = await this.options.agentSkills.findById(
      input.workspaceId,
      input.agentId,
      input.resolverSkillId,
    );
    if (!agentSkill?.enabled) {
      return null;
    }

    const skill = skillDefinitionForAgentSkill(agentSkill);
    if (!skill.execution) {
      return null;
    }

    const executor = this.options.skillExecutorRegistry.resolve(skill.execution);
    if (!executor) {
      return null;
    }

    let result: SkillDispatchResult;
    try {
      result = await executor.dispatch({
        skill,
        collected: {
          variableName: input.variableName,
          scope: input.scope,
        },
        context: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          sessionId: input.scope.id,
          variableName: input.variableName,
        },
        emit: noopSkillEmitPort,
        signal: input.signal,
      });
    } catch {
      return null;
    }

    if (result.disposition !== "settled" || !isSuccessfulOutcome(result.outcome)) {
      return null;
    }
    return extractResolverValue(result.outcome);
  }
}

type RuntimeSkillDefinition = SkillDefinition & {
  displayName?: string;
  execution?: SkillExecution;
  diagnostics?: Record<string, unknown>;
  steps?: unknown[];
  metadata?: Record<string, unknown>;
};

const skillDefinitionForAgentSkill = (agentSkill: AgentSkillSpine): RuntimeSkillDefinition => {
  const configuredExecution = executionFromConfig(agentSkill.config?.execution);
  return {
    name: agentSkill.skillName,
    displayName: agentSkill.skillName,
    description: "Context variable resolver skill routed through the skill executor registry.",
    owner: "platform",
    executionClass: "interactive",
    supportedCallers: [],
    requiredCapabilities: [],
    contractReferences: [],
    execution: configuredExecution ?? executionForKind(agentSkill.kind),
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
  };
};

const executionFromConfig = (value: unknown): SkillExecution | null => {
  if (!value || typeof value !== "object") {
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
        ? candidate.destinations.filter(isDeliveryDestination)
        : [],
      enqueue: typeof candidate.enqueue === "boolean" ? candidate.enqueue : false,
    };
  }
  if (
    candidate.kind === "webhook" &&
    isWebhookProvider(candidate.provider) &&
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

const isDeliveryDestination = (value: unknown): value is "email" | "webhook" =>
  value === "email" || value === "webhook";

const isWebhookProvider = (value: unknown): value is "make" | "zapier" | "custom" =>
  value === "make" || value === "zapier" || value === "custom";

const isSuccessfulOutcome = (outcome: SkillOutcome): boolean => {
  const status = outcome.status as string;
  return status === "completed" || status === "delivered";
};

const extractResolverValue = (outcome: SkillOutcome): { value: unknown } | null => {
  const outputs = outcome.outputs;
  if (!outputs) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(outputs, "value")) {
    return { value: outputs.value };
  }
  if (Object.prototype.hasOwnProperty.call(outputs, "data")) {
    return { value: outputs.data };
  }
  if (Object.keys(outputs).length > 0) {
    return { value: outputs };
  }
  return null;
};
