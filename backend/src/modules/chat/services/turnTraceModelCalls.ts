import type { ConversationTrace, ConversationTraceStage } from "@radioso/conversation-contract";

import type { ModelCallTraceRecord } from "../../../shared/observability/tracing/modelCallTraceContext.js";

const timestampMs = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const stageDurationMs = (stage: ConversationTraceStage): number => {
  const startedAt = timestampMs(stage.startedAt);
  const completedAt = timestampMs(stage.completedAt);
  return startedAt !== undefined && completedAt !== undefined
    ? Math.max(0, completedAt - startedAt)
    : Number.POSITIVE_INFINITY;
};

const encloses = (stage: ConversationTraceStage, call: ModelCallTraceRecord): boolean => {
  const stageStartedAt = timestampMs(stage.startedAt);
  const stageCompletedAt = timestampMs(stage.completedAt);
  const callStartedAt = timestampMs(call.startedAt);
  const callCompletedAt = timestampMs(call.completedAt);
  return stageStartedAt !== undefined
    && stageCompletedAt !== undefined
    && callStartedAt !== undefined
    && callCompletedAt !== undefined
    && callStartedAt >= stageStartedAt
    && callCompletedAt <= stageCompletedAt;
};

const stageForCall = (
  stages: ConversationTraceStage[],
  call: ModelCallTraceRecord,
): ConversationTraceStage | undefined => {
  const exactKind = call.operation === "turn_interpretation"
    ? "turn_interpretation"
    : call.operation === "directive_match"
      ? "directive_match"
      : undefined;
  if (exactKind) {
    const exact = stages.find((stage) => stage.kind === exactKind && encloses(stage, call));
    if (exact) {
      return exact;
    }
  }
  return stages
    .filter((stage) => stage.kind !== "retrieval_fanout" && encloses(stage, call))
    .sort((left, right) => stageDurationMs(left) - stageDurationMs(right))[0];
};

const aggregate = (calls: ModelCallTraceRecord[]): Record<string, number> => ({
  llmCallCount: calls.length,
  latencyMs: calls.reduce((total, call) => total + call.durationMs, 0),
  inputTokens: calls.reduce((total, call) => total + call.inputTokens, 0),
  outputTokens: calls.reduce((total, call) => total + call.outputTokens, 0),
  totalTokens: calls.reduce((total, call) => total + call.totalTokens, 0),
});

export const attachModelCallsToSpine = (
  spine: ConversationTrace,
  calls: ModelCallTraceRecord[],
): ConversationTrace => {
  const byStageId = new Map<string, ModelCallTraceRecord[]>();
  for (const call of calls) {
    const target = stageForCall(spine.stages, call);
    if (!target) {
      continue;
    }
    const assigned = byStageId.get(target.id) ?? [];
    assigned.push(call);
    byStageId.set(target.id, assigned);
  }
  if (byStageId.size === 0) {
    return spine;
  }

  return {
    ...spine,
    stages: spine.stages.map((stage) => {
      const assigned = byStageId.get(stage.id);
      if (!assigned) {
        return stage;
      }
      const models = [...new Set(assigned.map((call) => call.model))];
      const operations = [...new Set(assigned.map((call) => call.operation))];
      return {
        ...stage,
        inputs: {
          ...(stage.inputs ?? {}),
          ...(models.length === 1 ? { model: models[0] } : {}),
          ...(operations.length === 1 ? { operation: operations[0] } : {}),
        },
        outputs: {
          ...(stage.outputs ?? {}),
          modelCalls: assigned.map((call) => ({ ...call })),
        },
        metrics: {
          ...(stage.metrics ?? {}),
          ...aggregate(assigned),
        },
      };
    }),
  };
};
