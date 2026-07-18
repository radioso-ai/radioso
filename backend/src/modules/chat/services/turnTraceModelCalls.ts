import type { ConversationTrace, ConversationTraceStage } from "@radioso/conversation-contract";

import type { ModelCallTraceRecord } from "../../../shared/observability/tracing/modelCallTraceContext.js";

export const MODEL_CALLS_STAGE_ID = "model_calls";
export const PRE_ENGINE_MODEL_CALL_STAGE_ID = "pre_engine";

export interface AttributedModelCallTraceRecord extends ModelCallTraceRecord {
  stageId: string;
}

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
      : call.operation === "answer"
        || call.operation === "direct_answer"
        || call.operation === "grounded_answer"
        ? "compose"
        : undefined;
  if (exactKind) {
    const exact = stages.find((stage) => stage.kind === exactKind && encloses(stage, call))
      ?? stages.find((stage) => stage.kind === exactKind);
    if (exact) {
      return exact;
    }
  }
  return stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.kind !== MODEL_CALLS_STAGE_ID && encloses(stage, call))
    .sort((left, right) =>
      stageDurationMs(left.stage) - stageDurationMs(right.stage)
      || right.index - left.index)[0]?.stage;
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
  if (calls.length === 0) {
    return spine;
  }

  const stages = spine.stages.filter((stage) => stage.kind !== MODEL_CALLS_STAGE_ID);
  const byStageId = new Map<string, ModelCallTraceRecord[]>();
  const attributed: AttributedModelCallTraceRecord[] = calls.map((call) => {
    const target = stageForCall(stages, call);
    if (target) {
      const assigned = byStageId.get(target.id) ?? [];
      assigned.push(call);
      byStageId.set(target.id, assigned);
    }
    return {
      id: call.id,
      operation: call.operation,
      model: call.model,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      durationMs: call.durationMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      totalTokens: call.totalTokens,
      stageId: target?.id ?? PRE_ENGINE_MODEL_CALL_STAGE_ID,
    };
  });

  const enrichedStages = stages.map((stage) => {
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
        modelCallIds: assigned.map((call) => call.id),
      },
      metrics: {
        ...(stage.metrics ?? {}),
        ...aggregate(assigned),
      },
    };
  });

  return {
    ...spine,
    stages: [
      ...enrichedStages,
      {
        id: MODEL_CALLS_STAGE_ID,
        kind: MODEL_CALLS_STAGE_ID,
        status: "applied",
        outputs: { modelCalls: attributed },
        metrics: aggregate(calls),
      },
    ],
  };
};
