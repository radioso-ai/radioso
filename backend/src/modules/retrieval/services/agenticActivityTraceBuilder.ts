import { randomUUID } from "node:crypto";

import type {
  AgentBudgets,
  AgentRunResult,
  AgentTraceEvent,
} from "../../../shared/agent-runtime/index.js";
import type {
  ActivityLink,
  ActivityStage,
  ActivityTrace,
  AgenticTraceSummary,
} from "../domain/retrievalPipelineTypes.js";

const AGENT_STAGE_KIND = "agent_tool_call";

const MAX_RESULT_SUMMARY_CHARS = 500;

interface PendingCall {
  stepIndex: number;
  toolName: string;
  callId: string;
  startedAtMs: number;
  inputs: Record<string, unknown>;
  rationaleHint: string | null;
}

export interface AgenticTraceInput {
  events: ReadonlyArray<AgentTraceEvent>;
  runResult: AgentRunResult;
  selectedChunkIds: ReadonlyArray<string>;
  finalRationale: string | null;
  traceStartedAtMs: number;
  fallbackBudgets: AgentBudgets;
}

const toIso = (ms: number): string => new Date(ms).toISOString();

const buildResultSummary = (output: unknown): string => {
  try {
    const serialized = JSON.stringify(output);
    if (serialized == null) {
      return "";
    }
    return serialized.length > MAX_RESULT_SUMMARY_CHARS
      ? `${serialized.slice(0, MAX_RESULT_SUMMARY_CHARS)}…`
      : serialized;
  } catch {
    return "";
  }
};

const stageIdFor = (stepIndex: number, callId: string): string => `agent_step_${stepIndex}_${callId}`;

export const buildAgenticActivityTrace = (input: AgenticTraceInput): ActivityTrace => {
  const traceId = randomUUID();
  const stages: ActivityStage[] = [];
  const links: ActivityLink[] = [];
  const pending = new Map<string, PendingCall>();
  let resolvedBudgets: AgentBudgets = input.fallbackBudgets;
  const terminatedDueToValidation = input.runResult.terminatedReason === "tool_validation_failed";
  const terminatedDueToInvocation = input.runResult.terminatedReason === "tool_invocation_failed";
  // Track indexes of failed/rejected stages so we can post-process and mark
  // ONLY the last one as terminal. The runtime terminates on the *second*
  // consecutive failure of the same tool (FR-005 / FR-006), so the last
  // matching stage is the one that actually ended the run — not the first.
  const failedStageIndexes: number[] = [];
  const rejectedStageIndexes: number[] = [];

  const appendStage = (stage: ActivityStage): void => {
    const previous = stages.at(-1);
    stages.push(stage);
    if (previous) {
      links.push({ fromStageId: previous.stageId, toStageId: stage.stageId, kind: "sequence" });
    }
  };

  for (const event of input.events) {
    switch (event.kind) {
      case "budget_check": {
        if (event.resolvedBudgets) {
          resolvedBudgets = event.resolvedBudgets;
        }
        break;
      }
      case "tool_call_validated": {
        pending.set(event.callId, {
          stepIndex: event.stepIndex,
          toolName: event.toolName,
          callId: event.callId,
          startedAtMs: event.at,
          inputs: {
            toolName: event.toolName,
            callId: event.callId,
            stepIndex: event.stepIndex,
            arguments: event.input,
          },
          rationaleHint: null,
        });
        break;
      }
      case "tool_call_completed": {
        const call = pending.get(event.callId);
        if (!call) {
          break;
        }
        pending.delete(event.callId);
        appendStage({
          stageId: stageIdFor(call.stepIndex, call.callId),
          kind: AGENT_STAGE_KIND,
          label: `Agent: ${call.toolName}`,
          status: "applied",
          startedAt: toIso(call.startedAtMs),
          durationMs: event.latencyMs,
          inputs: call.inputs,
          outputs: {
            resultSummary: buildResultSummary(event.output),
          },
          metrics: {
            latencyMs: event.latencyMs,
            resultTokens: event.resultTokens,
          },
        });
        break;
      }
      case "tool_call_failed": {
        const call = pending.get(event.callId);
        if (!call) {
          break;
        }
        pending.delete(event.callId);
        appendStage({
          stageId: stageIdFor(call.stepIndex, call.callId),
          kind: AGENT_STAGE_KIND,
          label: `Agent: ${call.toolName}`,
          // Tentatively `fallback`; a post-processing pass promotes the LAST
          // failure to `failed` when the run terminated due to invocation.
          status: "fallback",
          startedAt: toIso(call.startedAtMs),
          durationMs: event.latencyMs,
          inputs: call.inputs,
          outputs: {
            errorReason: event.error,
          },
          metrics: {
            latencyMs: event.latencyMs,
          },
          reason: event.error,
        });
        failedStageIndexes.push(stages.length - 1);
        break;
      }
      case "tool_call_rejected": {
        appendStage({
          stageId: stageIdFor(event.stepIndex, event.callId),
          kind: AGENT_STAGE_KIND,
          label: `Agent: ${event.toolName}`,
          // Tentatively `fallback`; a post-processing pass promotes the LAST
          // rejection to `rejected` when the run terminated due to validation.
          status: "fallback",
          startedAt: toIso(event.at),
          durationMs: 0,
          inputs: {
            toolName: event.toolName,
            callId: event.callId,
            stepIndex: event.stepIndex,
          },
          outputs: {
            rejectionReason: event.reason,
            errorReason: event.details,
          },
          reason: event.details,
        });
        rejectedStageIndexes.push(stages.length - 1);
        break;
      }
      default:
        break;
    }
  }

  // Promote only the LAST failure/rejection stage to the terminal status when
  // the run terminated for that reason. The runtime terminates on the second
  // consecutive failure of the same tool — earlier failures were recoverable
  // and the model was given a chance to recover, so they stay `fallback`.
  if (terminatedDueToInvocation && failedStageIndexes.length > 0) {
    const lastIndex = failedStageIndexes[failedStageIndexes.length - 1];
    stages[lastIndex] = { ...stages[lastIndex], status: "failed" };
  }
  if (terminatedDueToValidation && rejectedStageIndexes.length > 0) {
    const lastIndex = rejectedStageIndexes[rejectedStageIndexes.length - 1];
    stages[lastIndex] = { ...stages[lastIndex], status: "rejected" };
  }

  // Attach the final rationale to the last applied stage as `outputs.rationale`
  // so the UI can render it on the finalize stage without a parallel field.
  if (input.finalRationale) {
    const finalizeStage = [...stages].reverse().find((stage) => stage.inputs?.toolName === "finalize");
    if (finalizeStage) {
      finalizeStage.outputs = {
        ...finalizeStage.outputs,
        rationale: input.finalRationale,
      };
    }
  }

  const summaryAgentic: AgenticTraceSummary = {
    terminatedReason: input.runResult.terminatedReason,
    stepsTaken: input.runResult.stepsTaken,
    toolResultTokensUsed: input.runResult.toolResultTokensUsed,
    wallTimeMs: input.runResult.wallTimeMs,
    resolvedBudgets,
    finalRationale: input.finalRationale,
    selectedChunkIds: [...input.selectedChunkIds],
  };

  return {
    traceId,
    startedAt: toIso(input.traceStartedAtMs),
    completedAt: toIso(input.traceStartedAtMs + input.runResult.wallTimeMs),
    totalDurationMs: input.runResult.wallTimeMs,
    stages,
    links,
    summary: {
      agentic: summaryAgentic,
    },
  };
};
