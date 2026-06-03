import type {
  ConversationSkillDispatcher,
  ConversationTrace,
  ConversationTraceStage,
  SelectedSkill,
  SkillDefinition,
  SkillOutcome,
  SkillOutcomeStatus,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";

import {
  CONVERSATION_TOOLS_ADAPTER,
  type ConversationToolDefinition,
  type ToolCallResult,
  type ToolService,
  type ToolSkillDefinition,
  type ToolSkillDefinitionOptions,
  type ToolSkillDispatchResult,
  type ToolSkillExecutorPort,
  type ToolSkillInvocation,
} from "./types.js";
import { getString, isRecord, recordFromUnknown } from "./typeGuards.js";

const SKILL_OUTCOME_STATUSES: ReadonlySet<string> = new Set<SkillOutcomeStatus>([
  "active",
  "paused",
  "completed",
  "failed",
  "awaiting_confirmation",
  "awaiting_tool",
  "cancelled",
  "expired",
]);

const nowIso = (): string => new Date().toISOString();
let traceCounter = 0;

const stage = (input: Omit<ConversationTraceStage, "startedAt" | "completedAt">): ConversationTraceStage => {
  const timestamp = nowIso();
  return {
    ...input,
    startedAt: timestamp,
    completedAt: timestamp,
  };
};

const createTrace = (stages: ConversationTraceStage[]): ConversationTrace => {
  const startedAt = stages[0]?.startedAt ?? nowIso();
  return {
    traceId: `conversation-tool-${startedAt}-${traceCounter++}`,
    startedAt,
    completedAt: stages.at(-1)?.completedAt ?? startedAt,
    stages,
  };
};

const traceStatusForOutcome = (status: SkillOutcomeStatus): ConversationTraceStage["status"] => {
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "expired") {
    return "fallback";
  }
  return "applied";
};

const isSkillOutcomeStatus = (value: unknown): value is SkillOutcomeStatus =>
  typeof value === "string" && SKILL_OUTCOME_STATUSES.has(value);

const isSkillOutcome = (value: unknown): value is SkillOutcome =>
  isRecord(value) && isSkillOutcomeStatus(value.status);

const isToolCallResult = (value: unknown): value is ToolCallResult =>
  isRecord(value) && (
    "status" in value ||
    "answer" in value ||
    "output" in value ||
    "outputs" in value ||
    "stagedContext" in value ||
    "guidance" in value ||
    "error" in value ||
    "subTrace" in value
  );

const outputRecord = (result: ToolCallResult): Record<string, unknown> | undefined => {
  if (result.outputs) {
    return result.outputs;
  }
  if ("output" in result) {
    return recordFromUnknown(result.output);
  }
  return undefined;
};

const normalizeToolResult = (result: ToolCallResult | SkillOutcome | unknown): SkillOutcome => {
  if (isSkillOutcome(result)) {
    return result;
  }
  if (isToolCallResult(result)) {
    return {
      status: result.status ?? "completed",
      ...(result.answer ? { answer: result.answer } : {}),
      ...(outputRecord(result) ? { outputs: outputRecord(result) } : {}),
      ...(result.control ? { control: result.control } : {}),
      ...(result.guidance ? { guidance: result.guidance } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
  return {
    status: "completed",
    ...(result !== undefined ? { outputs: recordFromUnknown(result) } : {}),
  };
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const failedOutcome = (toolName: string, error: unknown): SkillOutcome => ({
  status: "failed",
  error: {
    code: "tool_call_failed",
    message: errorMessage(error),
    retryable: false,
    metadata: { toolName },
  },
});

export const toolToSkillDefinition = (
  tool: ConversationToolDefinition,
  options: ToolSkillDefinitionOptions = {},
): ToolSkillDefinition => {
  const skillName = options.skillNamePrefix ? `${options.skillNamePrefix}.${tool.name}` : tool.name;
  return {
    name: skillName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    outcomeKinds: tool.outcomeKinds,
    metadata: {
      ...(tool.metadata ?? {}),
      ...(options.metadata ?? {}),
      conversationTool: {
        toolName: tool.name,
        ...(options.source ? { source: options.source } : {}),
      },
    },
    execution: {
      kind: "internal",
      adapter: options.executionAdapter ?? CONVERSATION_TOOLS_ADAPTER,
    },
  };
};

export const toolsToSkillDefinitions = (
  tools: ConversationToolDefinition[],
  options: ToolSkillDefinitionOptions = {},
): ToolSkillDefinition[] => tools.map((tool) => toolToSkillDefinition(tool, options));

export const getToolNameForSkill = (skill: SkillDefinition): string => {
  const metadata = skill.metadata;
  if (!metadata) {
    return skill.name;
  }
  const conversationTool = metadata.conversationTool;
  if (!isRecord(conversationTool)) {
    return skill.name;
  }
  return getString(conversationTool, "toolName") ?? skill.name;
};

export class ToolSkillBridge {
  constructor(
    private readonly service: ToolService,
    private readonly options: ToolSkillDefinitionOptions = {},
  ) {}

  async listSkillDefinitions(): Promise<ToolSkillDefinition[]> {
    return toolsToSkillDefinitions(await this.service.listTools(), this.options);
  }

  async dispatch(input: {
    skill: SkillDefinition;
    turn: TurnContext;
    selected: SelectedSkill;
  }): Promise<TurnOutcome> {
    const toolName = getToolNameForSkill(input.skill);
    let rawResult: ToolCallResult | SkillOutcome | unknown;
    let outcome: SkillOutcome;
    let status: ConversationTraceStage["status"] = "applied";

    try {
      rawResult = await this.service.callTool({
        toolName,
        input: input.selected.input,
        context: {
          turn: input.turn,
          skill: input.skill,
          selected: input.selected,
          metadata: input.selected.metadata,
        },
      });
      outcome = normalizeToolResult(rawResult);
      status = traceStatusForOutcome(outcome.status);
    } catch (error) {
      rawResult = {};
      outcome = failedOutcome(toolName, error);
      status = "failed";
    }

    const result = isToolCallResult(rawResult) ? rawResult : {};
    const dispatchStage = stage({
      id: `tool:${input.skill.name}`,
      kind: "tool_call",
      status,
      outputs: {
        skillName: input.skill.name,
        toolName,
        outcomeStatus: outcome.status,
      },
      ...(result.subTrace ? { subTrace: result.subTrace } : {}),
    });

    return {
      kind: "tool",
      skillName: input.skill.name,
      outcome,
      stagedContext: result.stagedContext ?? [],
      steering: result.steering ?? input.turn.steering,
      trace: createTrace([dispatchStage]),
      ...(result.subTrace ? { subTrace: result.subTrace } : {}),
    };
  }

  async dispatchOutcome(input: ToolSkillInvocation): Promise<SkillOutcome> {
    const toolName = getToolNameForSkill(input.skill);
    try {
      return normalizeToolResult(await this.service.callTool({
        toolName,
        input: input.collected,
        context: {
          skill: input.skill,
          signal: input.signal,
          metadata: input.context,
        },
      }));
    } catch (error) {
      return failedOutcome(toolName, error);
    }
  }
}

export const createToolSkillDispatcher = (
  service: ToolService,
  options: ToolSkillDefinitionOptions = {},
): ConversationSkillDispatcher => new ToolSkillBridge(service, options);

export const createToolSkillExecutor = (
  service: ToolService,
  options: ToolSkillDefinitionOptions = {},
): ToolSkillExecutorPort => {
  const bridge = new ToolSkillBridge(service, options);
  return {
    async dispatch(invocation: ToolSkillInvocation): Promise<ToolSkillDispatchResult> {
      return {
        disposition: "settled",
        // SkillDispatchResult can carry only the settled outcome here. Use the
        // full dispatch path when stagedContext, steering, or subTrace is needed.
        outcome: await bridge.dispatchOutcome(invocation),
      };
    },
  };
};
