import type { ZodType } from "zod";

export type TerminatedReason =
  | "completed"
  | "step_budget_exhausted"
  | "token_budget_exhausted"
  | "wall_time_exhausted"
  | "tool_validation_failed"
  | "tool_invocation_failed"
  | "cancelled";

export interface AgentToolContext {
  readonly signal: AbortSignal;
  readonly stepIndex: number;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  invoke(input: TInput, ctx: AgentToolContext): Promise<TOutput>;
  estimatedResultTokens?(input: TInput): number;
}

export interface AgentBudgets {
  readonly maxSteps: number;
  readonly maxToolResultTokens: number;
  readonly maxWallTimeMs: number;
}

export const AGENT_BUDGET_DEFAULTS: AgentBudgets = {
  maxSteps: 6,
  maxToolResultTokens: 12_000,
  maxWallTimeMs: 30_000,
};

export const AGENT_BUDGET_CEILINGS: AgentBudgets = {
  maxSteps: 16,
  maxToolResultTokens: 32_000,
  maxWallTimeMs: 120_000,
};

export interface AgentRunInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  readonly terminatedReason: TerminatedReason;
  readonly finalMessage: string | null;
  readonly stepsTaken: number;
  readonly toolResultTokensUsed: number;
  readonly wallTimeMs: number;
}

export type ToolRejectionReason = "unknown_tool" | "invalid_arguments";

export type AgentTraceEvent =
  | { kind: "step_started"; stepIndex: number; at: number }
  | { kind: "model_message"; stepIndex: number; content: string; at: number }
  | {
      kind: "tool_call_validated";
      stepIndex: number;
      toolName: string;
      callId: string;
      input: unknown;
      at: number;
    }
  | {
      kind: "tool_call_rejected";
      stepIndex: number;
      toolName: string;
      callId: string;
      reason: ToolRejectionReason;
      details: string;
      at: number;
    }
  | { kind: "tool_call_invoked"; stepIndex: number; toolName: string; callId: string; at: number }
  | {
      kind: "tool_call_completed";
      stepIndex: number;
      toolName: string;
      callId: string;
      output: unknown;
      resultTokens: number;
      latencyMs: number;
      at: number;
    }
  | {
      kind: "tool_call_failed";
      stepIndex: number;
      toolName: string;
      callId: string;
      error: string;
      latencyMs: number;
      at: number;
    }
  | {
      kind: "budget_check";
      stepIndex: number;
      budget: "ok" | "clamped" | keyof AgentBudgets;
      resolvedBudgets?: AgentBudgets;
      at: number;
    }
  | { kind: "terminated"; reason: TerminatedReason; at: number };

export interface TraceSink {
  emit(event: AgentTraceEvent): void;
}

export interface ModelToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly rawArguments: string;
}

export type ModelTranscriptEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ReadonlyArray<ModelToolCall> }
  | { role: "tool"; callId: string; toolName: string; content: string; isError: boolean };

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<unknown>;
}

export interface ModelToolCallRequest {
  readonly stepIndex: number;
  readonly systemPrompt: string;
  readonly transcript: ReadonlyArray<ModelTranscriptEntry>;
  readonly toolSchemas: ReadonlyArray<ToolSchema>;
  readonly signal: AbortSignal;
}

export interface ModelToolCallResponse {
  readonly assistantMessage: string;
  readonly toolCalls: ReadonlyArray<ModelToolCall>;
}

export interface ModelToolCallingGateway {
  request(input: ModelToolCallRequest): Promise<ModelToolCallResponse>;
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  readonly traceSink?: TraceSink;
  readonly now?: () => number;
  readonly clampBudgets?: boolean;
  /**
   * Timer hooks for the wall-time deadline. Default to global
   * setTimeout/clearTimeout. Injectable so tests can drive the deadline
   * deterministically without real timers.
   */
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface AgentRunStream {
  readonly events: AsyncIterable<AgentTraceEvent>;
  readonly result: Promise<AgentRunResult>;
}

export interface AgentRuntime {
  run(
    input: AgentRunInput,
    tools: ReadonlyArray<AgentTool>,
    budgets: AgentBudgets,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
  runStreaming(
    input: AgentRunInput,
    tools: ReadonlyArray<AgentTool>,
    budgets: AgentBudgets,
    options?: AgentRunOptions,
  ): AgentRunStream;
}
