import type { ConversationTrace, ConversationTraceStage } from "@radioso/conversation-contract";

import { MODEL_CALLS_STAGE_ID } from "./turnTraceModelCalls.js";

export interface TurnTraceSummary {
  totalLlmCalls: number;
  serialLlmDepth: number;
  longestStage: {
    name: string;
    durationMs: number;
  };
  totalModelTimeMs: number;
  totalTurnWallClockMs: number;
  droppedCallCount: number;
}

export interface TurnTraceModelCallSummary {
  totalLlmCalls: number;
  serialLlmDepth: number;
  totalModelTimeMs: number;
  totalTurnWallClockMs: number;
  droppedCallCount: number;
}

interface ModelCallInterval {
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs: number;
}

interface TimedTraceStage {
  name: string;
  durationMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const timestampMs = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const durationBetween = (startedAt: unknown, completedAt: unknown): number | undefined => {
  const startedAtMs = timestampMs(startedAt);
  const completedAtMs = timestampMs(completedAt);
  return startedAtMs !== undefined && completedAtMs !== undefined
    ? Math.max(0, completedAtMs - startedAtMs)
    : undefined;
};

const modelCallFromRecord = (value: unknown): ModelCallInterval | undefined => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.operation !== "string" || typeof value.model !== "string") {
    return undefined;
  }
  const startedAtMs = timestampMs(value.startedAt);
  const completedAtMs = timestampMs(value.completedAt);
  const durationMs = finiteNumber(value.durationMs)
    ?? (startedAtMs !== undefined && completedAtMs !== undefined
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined);
  return durationMs === undefined ? undefined : { startedAtMs, completedAtMs, durationMs };
};

const canonicalCallsFromSpine = (spine: ConversationTrace): ModelCallInterval[] => {
  const collection = spine.stages.find((stage) => stage.kind === MODEL_CALLS_STAGE_ID);
  const modelCalls = collection?.outputs?.modelCalls;
  return Array.isArray(modelCalls)
    ? modelCalls.flatMap((value) => {
        const call = modelCallFromRecord(value);
        return call ? [call] : [];
      })
    : [];
};

const capabilityStagesFrom = (stage: ConversationTraceStage): Record<string, unknown>[] => {
  const payload = stage.subTrace?.payload;
  if (!isRecord(payload) || !Array.isArray(payload.stages)) {
    return [];
  }
  return payload.stages.filter(isRecord);
};

const serialDepth = (calls: ModelCallInterval[]): number => {
  const timed = calls
    .filter((call): call is Required<Pick<ModelCallInterval, "startedAtMs" | "completedAtMs">> & ModelCallInterval =>
      call.startedAtMs !== undefined && call.completedAtMs !== undefined)
    .sort((left, right) => left.completedAtMs - right.completedAtMs);
  let depth = 0;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  for (const call of timed) {
    if (call.startedAtMs >= lastCompletedAt) {
      depth += 1;
      lastCompletedAt = call.completedAtMs;
    }
  }
  return depth + (calls.length - timed.length);
};

export const buildTurnTraceSummary = (
  spine: ConversationTrace,
  modelCallSummary?: TurnTraceModelCallSummary,
): TurnTraceSummary => {
  const calls = canonicalCallsFromSpine(spine);
  const timedStages: TimedTraceStage[] = [];

  for (const stage of spine.stages) {
    if (stage.kind !== MODEL_CALLS_STAGE_ID) {
      timedStages.push({
        name: stage.id,
        durationMs: durationBetween(stage.startedAt, stage.completedAt) ?? 0,
      });
    }
    for (const capabilityStage of capabilityStagesFrom(stage)) {
      timedStages.push({
        name: typeof capabilityStage.stageId === "string"
          ? capabilityStage.stageId
          : typeof capabilityStage.kind === "string"
            ? capabilityStage.kind
            : stage.id,
        durationMs: finiteNumber(capabilityStage.durationMs) ?? 0,
      });
    }
  }

  const longestStage = timedStages.reduce<TimedTraceStage>(
    (longest, candidate) => candidate.durationMs > longest.durationMs ? candidate : longest,
    { name: spine.stages[0]?.id ?? "turn", durationMs: 0 },
  );

  return {
    totalLlmCalls: modelCallSummary?.totalLlmCalls ?? calls.length,
    serialLlmDepth: modelCallSummary?.serialLlmDepth ?? serialDepth(calls),
    longestStage,
    totalModelTimeMs: modelCallSummary?.totalModelTimeMs
      ?? calls.reduce((total, call) => total + call.durationMs, 0),
    totalTurnWallClockMs: modelCallSummary?.totalTurnWallClockMs
      ?? durationBetween(spine.startedAt, spine.completedAt)
      ?? 0,
    droppedCallCount: modelCallSummary?.droppedCallCount ?? 0,
  };
};
