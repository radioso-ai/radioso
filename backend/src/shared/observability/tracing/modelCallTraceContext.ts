import { AsyncLocalStorage } from "node:async_hooks";

import type { LlmProviderName } from "../../infra/llm/providerTypes.js";

export const MAX_MODEL_CALL_TRACE_RECORDS = 64;

export interface ModelCallTraceRecord {
  id: string;
  operation: string;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ModelCallTraceInput extends Omit<ModelCallTraceRecord, "id" | "operation" | "model"> {
  operation: string;
  attemptKey: string;
  provider: LlmProviderName;
  model: string;
  status: "succeeded" | "failed";
}

const SAFE_OPERATION_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

const normalizeOperation = (value: string): string =>
  SAFE_OPERATION_PATTERN.test(value) ? value : "unknown";

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export class ModelCallTraceCollector {
  readonly calls: ModelCallTraceRecord[] = [];
  readonly startedAtMs: number;
  totalCallCount = 0;
  totalModelTimeMs = 0;
  serialLlmDepth = 0;

  private lastSerialCompletedAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    startedAtMs: number,
    private readonly maxRecords: number,
  ) {
    this.startedAtMs = startedAtMs;
  }

  get droppedCallCount(): number {
    return this.totalCallCount - this.calls.length;
  }

  record(input: ModelCallTraceInput): void {
    this.totalCallCount += 1;
    const durationMs = finiteNonNegative(input.durationMs);
    this.totalModelTimeMs += durationMs;

    const startedAtMs = Date.parse(input.startedAt);
    const completedAtMs = Date.parse(input.completedAt);
    if (
      Number.isFinite(startedAtMs)
      && Number.isFinite(completedAtMs)
      && startedAtMs >= this.lastSerialCompletedAtMs
    ) {
      this.serialLlmDepth += 1;
      this.lastSerialCompletedAtMs = completedAtMs;
    } else if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
      this.serialLlmDepth += 1;
    }

    if (this.calls.length >= this.maxRecords) {
      return;
    }
    this.calls.push({
      id: `model_call_${this.totalCallCount}`,
      operation: normalizeOperation(input.operation),
      model: input.model.slice(0, 128),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs,
      inputTokens: finiteNonNegative(input.inputTokens),
      outputTokens: finiteNonNegative(input.outputTokens),
      totalTokens: finiteNonNegative(input.totalTokens),
    });
  }
}

const modelCallTraceStorage = new AsyncLocalStorage<ModelCallTraceCollector>();

export const createModelCallTraceCollector = (
  input: { startedAtMs?: number; maxRecords?: number } = {},
): ModelCallTraceCollector => new ModelCallTraceCollector(
  input.startedAtMs ?? Date.now(),
  input.maxRecords ?? MAX_MODEL_CALL_TRACE_RECORDS,
);

export const runWithModelCallTrace = <T>(
  collector: ModelCallTraceCollector,
  run: () => T,
): T => modelCallTraceStorage.run(collector, run);

export const runAsyncIterableWithModelCallTrace = async function* <T>(
  collector: ModelCallTraceCollector,
  createIterable: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = runWithModelCallTrace(
    collector,
    () => createIterable()[Symbol.asyncIterator](),
  );
  let completed = false;
  try {
    while (true) {
      const step = await runWithModelCallTrace(collector, () => iterator.next());
      if (step.done) {
        completed = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await runWithModelCallTrace(collector, () => iterator.return!());
    }
  }
};

export const captureModelCallTrace = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; calls: ModelCallTraceRecord[]; collector: ModelCallTraceCollector }> => {
  const collector = createModelCallTraceCollector();
  const result = await runWithModelCallTrace(collector, run);
  return { result, calls: collector.calls, collector };
};

export const recordModelCallTrace = (record: ModelCallTraceInput): void => {
  modelCallTraceStorage.getStore()?.record(record);
};
