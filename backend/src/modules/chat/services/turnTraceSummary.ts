import type { ConversationTrace, ConversationTraceStage } from "@radioso/conversation-contract";

export interface TurnTraceSummary {
  totalLlmCalls: number;
  serialLlmDepth: number;
  longestStage: {
    name: string;
    durationMs: number;
  };
  totalModelTimeMs: number;
  totalTurnWallClockMs: number;
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
  if (!isRecord(value) || typeof value.operation !== "string" || typeof value.model !== "string") {
    return undefined;
  }
  const startedAtMs = timestampMs(value.startedAt);
  const completedAtMs = timestampMs(value.completedAt);
  const durationMs = finiteNumber(value.durationMs)
    ?? (startedAtMs !== undefined && completedAtMs !== undefined
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined);
  if (durationMs === undefined) {
    return undefined;
  }
  return { startedAtMs, completedAtMs, durationMs };
};

const callsFromSpineStage = (stage: ConversationTraceStage): ModelCallInterval[] => {
  const modelCalls = stage.outputs?.modelCalls;
  return Array.isArray(modelCalls)
    ? modelCalls.flatMap((value) => {
        const call = modelCallFromRecord(value);
        return call ? [call] : [];
      })
    : [];
};

const callFromCapabilityStage = (stage: Record<string, unknown>): ModelCallInterval | undefined => {
  const metrics = isRecord(stage.metrics) ? stage.metrics : {};
  const inputs = isRecord(stage.inputs) ? stage.inputs : {};
  const outputs = isRecord(stage.outputs) ? stage.outputs : {};
  const model = typeof inputs.model === "string"
    ? inputs.model
    : typeof outputs.model === "string"
      ? outputs.model
      : undefined;
  const hasTokenMetrics = finiteNumber(metrics.inputTokens) !== undefined
    || finiteNumber(metrics.outputTokens) !== undefined
    || finiteNumber(metrics.totalTokens) !== undefined;
  if (!model || !hasTokenMetrics) {
    return undefined;
  }
  const startedAtMs = timestampMs(stage.startedAt);
  const durationMs = finiteNumber(metrics.latencyMs) ?? finiteNumber(stage.durationMs);
  if (durationMs === undefined) {
    return undefined;
  }
  return {
    startedAtMs,
    completedAtMs: startedAtMs === undefined ? undefined : startedAtMs + durationMs,
    durationMs,
  };
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

export const buildTurnTraceSummary = (spine: ConversationTrace): TurnTraceSummary => {
  const calls: ModelCallInterval[] = [];
  const timedStages: TimedTraceStage[] = [];

  for (const stage of spine.stages) {
    calls.push(...callsFromSpineStage(stage));
    timedStages.push({
      name: stage.id,
      durationMs: durationBetween(stage.startedAt, stage.completedAt) ?? 0,
    });
    for (const capabilityStage of capabilityStagesFrom(stage)) {
      const call = callFromCapabilityStage(capabilityStage);
      if (call) {
        calls.push(call);
      }
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
    totalLlmCalls: calls.length,
    serialLlmDepth: serialDepth(calls),
    longestStage,
    totalModelTimeMs: calls.reduce((total, call) => total + call.durationMs, 0),
    totalTurnWallClockMs: durationBetween(spine.startedAt, spine.completedAt) ?? 0,
  };
};
