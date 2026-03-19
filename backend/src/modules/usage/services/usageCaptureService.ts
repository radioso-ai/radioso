import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { UsageEventInsertInput, UsageEventRepositoryPort } from "../../../db/repositories/usageEventRepository.js";

export interface UsageMetrics {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageAvailable: boolean;
}

export interface UsageAttributionRefs {
  accountId?: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  documentId?: string | null;
  processingJobId?: string | null;
}

export interface ObservedUsageOperation extends UsageAttributionRefs {
  operationKey?: string;
  sourceArea: string;
  operationType: string;
  model: string;
  eventStatus: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  usageAvailable?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

interface UsageScopeStore {
  refs: UsageAttributionRefs;
  deferPersistUntilFlush: boolean;
  drafts: ObservedUsageOperation[];
}

const toNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
};

const readNumericField = (usage: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = toNonNegativeInt(usage[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
};

export const extractUsageMetrics = (usage: unknown): UsageMetrics => {
  if (!usage || typeof usage !== "object") {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageAvailable: false,
    };
  }

  const usageRecord = usage as Record<string, unknown>;
  const promptTokens = readNumericField(usageRecord, ["prompt_tokens", "input_tokens", "promptTokens"]);
  const completionTokens = readNumericField(usageRecord, ["completion_tokens", "output_tokens", "completionTokens"]);
  const totalTokens =
    readNumericField(usageRecord, ["total_tokens", "totalTokens"]) ??
    (promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    usageAvailable: promptTokens !== null || completionTokens !== null || totalTokens !== null,
  };
};

const mergeRefs = (
  base: UsageAttributionRefs,
  override: UsageAttributionRefs,
): UsageAttributionRefs => ({
  accountId: override.accountId ?? base.accountId,
  workspaceId: override.workspaceId ?? base.workspaceId,
  conversationId: override.conversationId ?? base.conversationId,
  userMessageId: override.userMessageId ?? base.userMessageId,
  assistantMessageId: override.assistantMessageId ?? base.assistantMessageId,
  documentId: override.documentId ?? base.documentId,
  processingJobId: override.processingJobId ?? base.processingJobId,
});

const normalizeObservedOperation = (input: ObservedUsageOperation): ObservedUsageOperation => {
  const promptTokens = toNonNegativeInt(input.promptTokens);
  const completionTokens = toNonNegativeInt(input.completionTokens);
  const totalTokens =
    toNonNegativeInt(input.totalTokens) ??
    (promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null);

  return {
    ...input,
    promptTokens,
    completionTokens,
    totalTokens,
    usageAvailable: input.usageAvailable ?? (
      promptTokens !== null ||
      completionTokens !== null ||
      totalTokens !== null
    ),
    occurredAt: input.occurredAt ?? new Date(),
    metadata: input.metadata ?? {},
  };
};

const toInsertInput = (input: ObservedUsageOperation & { accountId: string }): UsageEventInsertInput => ({
  operationKey: input.operationKey ?? randomUUID(),
  accountId: input.accountId,
  workspaceId: input.workspaceId ?? null,
  conversationId: input.conversationId ?? null,
  userMessageId: input.userMessageId ?? null,
  assistantMessageId: input.assistantMessageId ?? null,
  documentId: input.documentId ?? null,
  processingJobId: input.processingJobId ?? null,
  sourceArea: input.sourceArea,
  operationType: input.operationType,
  model: input.model,
  eventStatus: input.eventStatus,
  usageAvailable: Boolean(input.usageAvailable),
  promptTokens: input.promptTokens ?? null,
  completionTokens: input.completionTokens ?? null,
  totalTokens: input.totalTokens ?? null,
  metadata: input.metadata ?? {},
  occurredAt: input.occurredAt ?? new Date(),
});

export class UsageCaptureService {
  private readonly storage = new AsyncLocalStorage<UsageScopeStore>();

  constructor(private readonly usageEventRepository: UsageEventRepositoryPort) {}

  async runInScope<T>(
    input: UsageAttributionRefs & { deferPersistUntilFlush?: boolean },
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.storage.run(this.createStore(input), callback);
  }

  async *runGeneratorInScope<T>(
    input: UsageAttributionRefs & { deferPersistUntilFlush?: boolean },
    createIterator: () => AsyncGenerator<T>,
  ): AsyncGenerator<T> {
    const store = this.createStore(input);
    const iterator = createIterator();

    while (true) {
      const result = await this.storage.run(store, () => iterator.next());
      if (result.done) {
        return result.value;
      }
      yield result.value;
    }
  }

  async observe(input: ObservedUsageOperation): Promise<void> {
    const normalized = normalizeObservedOperation(input);
    const store = this.storage.getStore();

    if (!store) {
      if (!normalized.accountId) {
        return;
      }
      await this.usageEventRepository.record(toInsertInput(normalized as ObservedUsageOperation & { accountId: string }));
      return;
    }

    if (store.deferPersistUntilFlush) {
      store.drafts.push(normalized);
      return;
    }

    const merged = {
      ...normalized,
      ...mergeRefs(store.refs, normalized),
    };

    if (!merged.accountId) {
      return;
    }

    await this.usageEventRepository.record(toInsertInput(merged as ObservedUsageOperation & { accountId: string }));
  }

  async flushCurrentScope(extraRefs: UsageAttributionRefs = {}): Promise<void> {
    const store = this.storage.getStore();
    if (!store || store.drafts.length === 0) {
      return;
    }

    const drafts = [...store.drafts];
    store.drafts.length = 0;

    for (const draft of drafts) {
      const merged = {
        ...draft,
        ...mergeRefs(store.refs, mergeRefs(draft, extraRefs)),
      };

      if (!merged.accountId) {
        continue;
      }

      await this.usageEventRepository.record(toInsertInput(merged as ObservedUsageOperation & { accountId: string }));
    }
  }

  private createStore(input: UsageAttributionRefs & { deferPersistUntilFlush?: boolean }): UsageScopeStore {
    return {
      refs: input,
      deferPersistUntilFlush: Boolean(input.deferPersistUntilFlush),
      drafts: [],
    };
  }
}
