import {
  AGENT_BUDGET_CEILINGS,
  type AgentBudgets,
  type AgentRunInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunStream,
  type AgentRuntime,
  type AgentTool,
  type AgentTraceEvent,
  type ModelToolCall,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
  type ModelTranscriptEntry,
  type TerminatedReason,
  type ToolRejectionReason,
  type ToolSchema,
  type TraceSink,
} from "./types.js";

export interface DefaultAgentRuntimeDeps {
  readonly gateway: ModelToolCallingGateway;
}

interface InvocationFailureFingerprint {
  readonly toolName: string;
  readonly argsKey: string;
}

const APPROX_TOKEN_BYTES = 4;

const stableArgsKey = (raw: string): string => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, Object.keys(parsed ?? {}).sort());
  } catch {
    return raw;
  }
};

const estimateTokensFromOutput = (output: unknown): number => {
  try {
    const serialized = JSON.stringify(output) ?? "";
    return Math.max(1, Math.ceil(serialized.length / APPROX_TOKEN_BYTES));
  } catch {
    return 1;
  }
};

const serializeForTranscript = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const clampBudget = (
  requested: AgentBudgets,
  enabled: boolean,
): { resolved: AgentBudgets; clamped: boolean } => {
  if (!enabled) {
    return { resolved: requested, clamped: false };
  }
  const resolved: AgentBudgets = {
    maxSteps: Math.min(requested.maxSteps, AGENT_BUDGET_CEILINGS.maxSteps),
    maxToolResultTokens: Math.min(
      requested.maxToolResultTokens,
      AGENT_BUDGET_CEILINGS.maxToolResultTokens,
    ),
    maxWallTimeMs: Math.min(requested.maxWallTimeMs, AGENT_BUDGET_CEILINGS.maxWallTimeMs),
  };
  const clamped =
    resolved.maxSteps !== requested.maxSteps ||
    resolved.maxToolResultTokens !== requested.maxToolResultTokens ||
    resolved.maxWallTimeMs !== requested.maxWallTimeMs;
  return { resolved, clamped };
};

const buildToolSchemas = (tools: ReadonlyArray<AgentTool>): ToolSchema[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

const findTool = (
  tools: ReadonlyArray<AgentTool>,
  name: string,
): AgentTool | undefined => tools.find((tool) => tool.name === name);

const toolErrorTranscriptEntry = (
  call: ModelToolCall,
  message: string,
): ModelTranscriptEntry => ({
  role: "tool",
  callId: call.callId,
  toolName: call.toolName,
  content: message,
  isError: true,
});

const toolSuccessTranscriptEntry = (
  call: ModelToolCall,
  output: unknown,
): ModelTranscriptEntry => ({
  role: "tool",
  callId: call.callId,
  toolName: call.toolName,
  content: serializeForTranscript(output),
  isError: false,
});

const assistantTranscriptEntry = (response: ModelToolCallResponse): ModelTranscriptEntry => ({
  role: "assistant",
  content: response.assistantMessage,
  toolCalls: response.toolCalls,
});

const combineSinks = (sinks: ReadonlyArray<TraceSink | undefined>): TraceSink => ({
  emit(event) {
    for (const sink of sinks) {
      sink?.emit(event);
    }
  },
});

class TerminationSignal extends Error {
  constructor(readonly reason: TerminatedReason) {
    super(`agent_runtime_terminate:${reason}`);
    this.name = "AgentRuntimeTermination";
  }
}

interface RunContext {
  readonly input: AgentRunInput;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly budgets: AgentBudgets;
  readonly options: AgentRunOptions;
  readonly sink: TraceSink;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly gatewayRequest: ModelToolCallingGateway["request"];
  /**
   * True when the combined signal aborted because the wall-time deadline fired
   * (as opposed to the caller cancelling). Lets the loop distinguish
   * `wall_time_exhausted` from `cancelled` when an in-flight call is aborted.
   */
  readonly isDeadlineAborted: () => boolean;
}

const abortTerminationReason = (ctx: RunContext): TerminatedReason =>
  ctx.isDeadlineAborted() ? "wall_time_exhausted" : "cancelled";

interface RunState {
  stepIndex: number;
  stepsTaken: number;
  toolResultTokensUsed: number;
  transcript: ModelTranscriptEntry[];
  lastValidationFailureByTool: Map<string, number>;
  lastInvocationFailure: InvocationFailureFingerprint | null;
  finalMessage: string | null;
}

const emitTerminated = (sink: TraceSink, reason: TerminatedReason, now: () => number): void => {
  sink.emit({ kind: "terminated", reason, at: now() });
};

const checkSignal = (ctx: RunContext): void => {
  if (ctx.signal.aborted) {
    throw new TerminationSignal(abortTerminationReason(ctx));
  }
};

const enforceWallTime = (
  startedAt: number,
  now: () => number,
  maxWallTimeMs: number,
): void => {
  if (now() - startedAt >= maxWallTimeMs) {
    throw new TerminationSignal("wall_time_exhausted");
  }
};

const processToolCall = async (
  ctx: RunContext,
  state: RunState,
  call: ModelToolCall,
): Promise<void> => {
  const tool = findTool(ctx.tools, call.toolName);
  if (!tool) {
    recordValidationFailure(ctx, state, call, "unknown_tool", `Unknown tool '${call.toolName}'.`);
    return;
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = call.rawArguments.length === 0 ? {} : JSON.parse(call.rawArguments);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordValidationFailure(ctx, state, call, "invalid_arguments", `Arguments are not valid JSON: ${message}`);
    return;
  }

  const validation = tool.inputSchema.safeParse(parsedArgs);
  if (!validation.success) {
    recordValidationFailure(
      ctx,
      state,
      call,
      "invalid_arguments",
      `Arguments failed validation: ${validation.error.message}`,
    );
    return;
  }

  // A successful validation clears the consecutive-failure counter for this tool.
  state.lastValidationFailureByTool.delete(call.toolName);
  ctx.sink.emit({
    kind: "tool_call_validated",
    stepIndex: state.stepIndex,
    toolName: call.toolName,
    callId: call.callId,
    input: validation.data,
    at: ctx.now(),
  });

  await invokeTool(ctx, state, tool, call, validation.data);
};

const recordValidationFailure = (
  ctx: RunContext,
  state: RunState,
  call: ModelToolCall,
  reason: ToolRejectionReason,
  details: string,
): void => {
  ctx.sink.emit({
    kind: "tool_call_rejected",
    stepIndex: state.stepIndex,
    toolName: call.toolName,
    callId: call.callId,
    reason,
    details,
    at: ctx.now(),
  });
  state.transcript.push(toolErrorTranscriptEntry(call, details));
  const next = (state.lastValidationFailureByTool.get(call.toolName) ?? 0) + 1;
  state.lastValidationFailureByTool.set(call.toolName, next);
  if (next >= 2) {
    throw new TerminationSignal("tool_validation_failed");
  }
};

const invokeTool = async (
  ctx: RunContext,
  state: RunState,
  tool: AgentTool,
  call: ModelToolCall,
  input: unknown,
): Promise<void> => {
  ctx.sink.emit({
    kind: "tool_call_invoked",
    stepIndex: state.stepIndex,
    toolName: call.toolName,
    callId: call.callId,
    at: ctx.now(),
  });

  const fingerprint: InvocationFailureFingerprint = {
    toolName: call.toolName,
    argsKey: stableArgsKey(call.rawArguments),
  };
  const invokedAt = ctx.now();

  let output: unknown;
  try {
    output = await tool.invoke(input as never, {
      signal: ctx.signal,
      stepIndex: state.stepIndex,
      callId: call.callId,
    });
  } catch (err) {
    const latencyMs = ctx.now() - invokedAt;
    const message = err instanceof Error ? err.message : String(err);
    ctx.sink.emit({
      kind: "tool_call_failed",
      stepIndex: state.stepIndex,
      toolName: call.toolName,
      callId: call.callId,
      error: message,
      latencyMs,
      at: ctx.now(),
    });
    state.transcript.push(toolErrorTranscriptEntry(call, `Tool invocation failed: ${message}`));
    if (
      state.lastInvocationFailure &&
      state.lastInvocationFailure.toolName === fingerprint.toolName &&
      state.lastInvocationFailure.argsKey === fingerprint.argsKey
    ) {
      throw new TerminationSignal("tool_invocation_failed");
    }
    state.lastInvocationFailure = fingerprint;
    return;
  }

  const latencyMs = ctx.now() - invokedAt;
  const tokens = tool.estimatedResultTokens
    ? tool.estimatedResultTokens(input as never)
    : estimateTokensFromOutput(output);
  state.toolResultTokensUsed += tokens;
  state.lastInvocationFailure = null;
  ctx.sink.emit({
    kind: "tool_call_completed",
    stepIndex: state.stepIndex,
    toolName: call.toolName,
    callId: call.callId,
    output,
    resultTokens: tokens,
    latencyMs,
    at: ctx.now(),
  });
  state.transcript.push(toolSuccessTranscriptEntry(call, output));
};

/**
 * Terminations that must not spend another model call: the run is out of its wall-time budget, or
 * the caller cancelled. Asking for a closing answer there is the opposite of what was asked for.
 */
const NO_CLOSING_CALL: ReadonlySet<TerminatedReason> = new Set(["wall_time_exhausted", "cancelled"]);

/**
 * Steps the tool loop may take. FR-003 makes `maxSteps` a hard ceiling on model calls, so a caller
 * that requires an answer buys it out of that budget rather than on top of it: the loop stops one
 * step early and the closing call spends what it left. Without the flag the ceiling is the budget,
 * unchanged.
 */
const toolLoopMaxSteps = (ctx: RunContext): number =>
  ctx.options.requireFinalMessage === true ? Math.max(0, ctx.budgets.maxSteps - 1) : ctx.budgets.maxSteps;

/**
 * True when there is nothing to show the caller.
 *
 * The production gateway's protocol requires `text` to be empty whenever `tool_calls` is non-empty,
 * and it coerces a missing `text` to `""`, so a blank answer arrives as an empty string far more
 * often than as null. Checking only for null would leave the fallback dead against a real provider.
 */
const isBlank = (message: string | null): boolean => message === null || message.trim() === "";

/**
 * Asks the model to answer from the transcript it already has, with no tools offered. The wording
 * is the model's: the transcript carries the question and every tool error, which is what an
 * explanation has to be built from.
 */
const requestClosingMessage = async (ctx: RunContext, state: RunState): Promise<string | null> => {
  // A step of its own, counted. `TextRoutedToolCallingGateway` derives the usage idempotency key
  // from `agent_step:${stepIndex}` and the recorder drops a duplicate, so reusing the failed step's
  // index would bill this call as that one and lose its tokens. `toolLoopMaxSteps` reserved room
  // for it, so counting it keeps `stepsTaken` equal to the model calls actually made.
  state.stepIndex += 1;
  state.stepsTaken += 1;
  try {
    const response = await ctx.gatewayRequest({
      stepIndex: state.stepIndex,
      systemPrompt: ctx.input.systemPrompt,
      transcript: state.transcript,
      toolSchemas: [],
      signal: ctx.signal,
      usageContext: ctx.options.usageContext,
    });
    ctx.sink.emit({
      kind: "model_message",
      stepIndex: state.stepIndex,
      content: response.assistantMessage,
      at: ctx.now(),
    });
    return isBlank(response.assistantMessage) ? null : response.assistantMessage;
  } catch (err) {
    // An abort is the exception: the caller cancelled, or the deadline fired, and that is the
    // outcome of record. Swallowing it here would report the earlier reason for a turn that was
    // actually cancelled, and put the wrong outcome in the audit trail.
    if (ctx.signal.aborted) throw new TerminationSignal(abortTerminationReason(ctx));
    // Any other failed closing attempt must never replace the run's own outcome with a throw: the
    // caller asked why the run ended, and "the recovery call also failed" is not a better answer.
    // It is still said out loud, because the operator gets a blank turn either way and support
    // cannot otherwise tell a failed recovery from a model that simply said nothing.
    ctx.sink.emit({
      kind: "model_call_failed",
      stepIndex: state.stepIndex,
      phase: "closing_message",
      error: err instanceof Error ? err.message : "Closing model call threw a non-Error value.",
      at: ctx.now(),
    });
    return null;
  }
};

const runLoop = async (ctx: RunContext): Promise<AgentRunResult> => {
  const startedAt = ctx.now();
  const state: RunState = {
    stepIndex: 0,
    stepsTaken: 0,
    toolResultTokensUsed: 0,
    transcript: [{ role: "user", content: ctx.input.userMessage }],
    lastValidationFailureByTool: new Map(),
    lastInvocationFailure: null,
    finalMessage: null,
  };

  /**
   * Ends the run, and refuses to end it blank.
   *
   * `finalMessage` only ever holds the last assistant message, so any termination reached while the
   * model was calling tools rather than talking returns null — the caller renders nothing at all.
   * Measured live, that is what a Ray turn looked like after it reached for two tools that do not
   * exist and then one literally named "none": the operator got a blank answer to a question that
   * deserved "I could not do that". One more call, with no tools offered so it cannot start another
   * loop, is the difference between a dead turn and a plain one.
   */
  const finalize = async (initialReason: TerminatedReason): Promise<AgentRunResult> => {
    let reason = initialReason;
    if (
      ctx.options.requireFinalMessage === true &&
      isBlank(state.finalMessage) &&
      !NO_CLOSING_CALL.has(reason) &&
      !ctx.signal.aborted
    ) {
      try {
        state.finalMessage = await requestClosingMessage(ctx, state);
      } catch (err) {
        if (!(err instanceof TerminationSignal)) throw err;
        // The closing call was cancelled or ran out of time. That is what happened to this turn.
        reason = err.reason;
      }
    }
    emitTerminated(ctx.sink, reason, ctx.now);
    return {
      terminatedReason: reason,
      finalMessage: state.finalMessage,
      stepsTaken: state.stepsTaken,
      toolResultTokensUsed: state.toolResultTokensUsed,
      wallTimeMs: ctx.now() - startedAt,
    };
  };

  try {
    checkSignal(ctx);
  } catch (err) {
    if (err instanceof TerminationSignal) {
      return finalize(err.reason);
    }
    throw err;
  }

  const toolSchemas = buildToolSchemas(ctx.tools);

  while (true) {
    try {
      checkSignal(ctx);
      enforceWallTime(startedAt, ctx.now, ctx.budgets.maxWallTimeMs);
    } catch (err) {
      if (err instanceof TerminationSignal) {
        return finalize(err.reason);
      }
      throw err;
    }

    if (state.stepIndex >= toolLoopMaxSteps(ctx)) {
      return finalize("step_budget_exhausted");
    }

    ctx.sink.emit({ kind: "step_started", stepIndex: state.stepIndex, at: ctx.now() });

    let response: ModelToolCallResponse;
    try {
      response = await ctx.gatewayRequest({
        stepIndex: state.stepIndex,
        systemPrompt: ctx.input.systemPrompt,
        transcript: state.transcript,
        toolSchemas,
        signal: ctx.signal,
        usageContext: ctx.options.usageContext,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        return finalize(abortTerminationReason(ctx));
      }
      throw err;
    }

    state.transcript.push(assistantTranscriptEntry(response));
    state.finalMessage = response.assistantMessage;
    state.stepsTaken += 1;
    ctx.sink.emit({
      kind: "model_message",
      stepIndex: state.stepIndex,
      content: response.assistantMessage,
      at: ctx.now(),
    });

    if (response.toolCalls.length === 0) {
      return finalize("completed");
    }

    try {
      for (const call of response.toolCalls) {
        await processToolCall(ctx, state, call);
      }
    } catch (err) {
      if (err instanceof TerminationSignal) {
        return finalize(err.reason);
      }
      throw err;
    }

    if (state.toolResultTokensUsed >= ctx.budgets.maxToolResultTokens) {
      return finalize("token_budget_exhausted");
    }

    ctx.sink.emit({
      kind: "budget_check",
      stepIndex: state.stepIndex,
      budget: "ok",
      at: ctx.now(),
    });

    state.stepIndex += 1;

    if (ctx.signal.aborted) {
      return finalize(abortTerminationReason(ctx));
    }
  }
};

export class DefaultAgentRuntime implements AgentRuntime {
  constructor(private readonly deps: DefaultAgentRuntimeDeps) {}

  run(
    input: AgentRunInput,
    tools: ReadonlyArray<AgentTool>,
    budgets: AgentBudgets,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const { stream } = this.startInternal(input, tools, budgets, options);
    return stream.result;
  }

  runStreaming(
    input: AgentRunInput,
    tools: ReadonlyArray<AgentTool>,
    budgets: AgentBudgets,
    options: AgentRunOptions = {},
  ): AgentRunStream {
    return this.startInternal(input, tools, budgets, options).stream;
  }

  private startInternal(
    input: AgentRunInput,
    tools: ReadonlyArray<AgentTool>,
    budgets: AgentBudgets,
    options: AgentRunOptions,
  ): { stream: AgentRunStream } {
    const now = options.now ?? (() => Date.now());
    const callerSignal = options.signal ?? new AbortController().signal;
    const queue = createEventQueue();
    const sink = combineSinks([queue.sink, options.traceSink]);

    const { resolved, clamped } = clampBudget(budgets, options.clampBudgets !== false);
    sink.emit({
      kind: "budget_check",
      stepIndex: 0,
      budget: clamped ? "clamped" : "ok",
      resolvedBudgets: resolved,
      at: now(),
    });

    // Derive a hard wall-time deadline. Unlike the between-steps check, this
    // aborts the signal so an in-flight provider/tool call is interrupted
    // rather than blocking past the budget. The combined signal cancels when
    // either the caller cancels or the deadline fires.
    const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const deadlineController = new AbortController();
    const timerHandle = setTimer(() => deadlineController.abort(), resolved.maxWallTimeMs);
    const combinedSignal = AbortSignal.any([callerSignal, deadlineController.signal]);

    const ctx: RunContext = {
      input,
      tools,
      budgets: resolved,
      options,
      sink,
      now,
      signal: combinedSignal,
      gatewayRequest: this.deps.gateway.request.bind(this.deps.gateway),
      isDeadlineAborted: () => deadlineController.signal.aborted,
    };

    const result = runLoop(ctx)
      .then((value) => {
        clearTimer(timerHandle);
        queue.close();
        return value;
      })
      .catch((err) => {
        clearTimer(timerHandle);
        queue.close();
        throw err;
      });

    return { stream: { events: queue.iterable, result } };
  }
}

interface EventQueue {
  readonly sink: TraceSink;
  readonly iterable: AsyncIterable<AgentTraceEvent>;
  close(): void;
}

const createEventQueue = (): EventQueue => {
  const buffer: AgentTraceEvent[] = [];
  const waiters: Array<(value: IteratorResult<AgentTraceEvent>) => void> = [];
  let closed = false;

  const sink: TraceSink = {
    emit(event) {
      if (closed) {
        return;
      }
      if (waiters.length > 0) {
        const next = waiters.shift();
        next?.({ value: event, done: false });
        return;
      }
      buffer.push(event);
    },
  };

  const iterable: AsyncIterable<AgentTraceEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentTraceEvent> {
      return {
        next(): Promise<IteratorResult<AgentTraceEvent>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as AgentTraceEvent;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise<IteratorResult<AgentTraceEvent>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };

  return {
    sink,
    iterable,
    close(): void {
      closed = true;
      while (waiters.length > 0) {
        const next = waiters.shift();
        next?.({ value: undefined as never, done: true });
      }
    },
  };
};
