import type {
  CapabilitySubTrace,
  SelectedSkill,
  SkillDefinition,
  SkillOutcome,
  SkillOutcomeControl,
  SkillOutcomeError,
  SkillOutcomeStatus,
  SkillTransientGuidance,
  StagedContext,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

export const CONVERSATION_TOOLS_ADAPTER = "conversation-tools";

export interface ConversationToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  outcomeKinds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolCallContext {
  turn?: TurnContext;
  skill?: SkillDefinition;
  selected?: SelectedSkill;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolCallInput {
  toolName: string;
  input?: unknown;
  context?: ToolCallContext;
}

export interface ToolCallResult {
  status?: SkillOutcomeStatus;
  answer?: string;
  output?: unknown;
  outputs?: Record<string, unknown>;
  control?: SkillOutcomeControl;
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;
  error?: SkillOutcomeError;
  stagedContext?: StagedContext[];
  steering?: SteeringRule[];
  subTrace?: CapabilitySubTrace;
}

export interface ToolService {
  listTools(): Promise<ConversationToolDefinition[]>;
  callTool(input: ToolCallInput): Promise<ToolCallResult | SkillOutcome | unknown>;
}

export interface ToolSkillMetadata {
  toolName: string;
  source?: string;
}

export interface ToolSkillDefinition extends SkillDefinition {
  metadata: Record<string, unknown> & {
    conversationTool: ToolSkillMetadata;
  };
  execution: {
    kind: "internal";
    adapter: typeof CONVERSATION_TOOLS_ADAPTER | string;
  };
}

export interface ToolSkillDefinitionOptions {
  skillNamePrefix?: string;
  source?: string;
  executionAdapter?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolSkillEmitPort {
  emitStatus(status: string, data?: Record<string, unknown>): Promise<void>;
  emitCustom(data: Record<string, unknown>): Promise<void>;
}

export interface ToolSkillInvocation {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  context?: Record<string, unknown>;
  emit: ToolSkillEmitPort;
  signal?: AbortSignal;
}

export type ToolSkillDispatchResult =
  | { disposition: "settled"; outcome: SkillOutcome }
  | { disposition: "deferred"; ticket: { ticketId: string } };

export interface ToolSkillExecutorPort {
  dispatch(invocation: ToolSkillInvocation): Promise<ToolSkillDispatchResult>;
}
