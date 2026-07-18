import { AsyncLocalStorage } from "node:async_hooks";

import type { LlmProviderName } from "../../infra/llm/providerTypes.js";

export interface ModelCallTraceRecord {
  operation: string;
  attemptKey: string;
  provider: LlmProviderName;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: "succeeded" | "failed";
}

const modelCallTraceStorage = new AsyncLocalStorage<ModelCallTraceRecord[]>();

export const runWithModelCallTrace = <T>(
  calls: ModelCallTraceRecord[],
  run: () => T,
): T => modelCallTraceStorage.run(calls, run);

export const captureModelCallTrace = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; calls: ModelCallTraceRecord[] }> => {
  const calls: ModelCallTraceRecord[] = [];
  const result = await runWithModelCallTrace(calls, run);
  return { result, calls };
};

export const recordModelCallTrace = (record: ModelCallTraceRecord): void => {
  modelCallTraceStorage.getStore()?.push({ ...record });
};
