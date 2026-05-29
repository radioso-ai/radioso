// The canonical recorder contract lives in @radioso/usage-contract so OSS and
// EE share one definition. This module re-exports it (keeping existing OSS
// import paths stable) and owns the OSS no-op default implementation.
export type {
  EmbeddingUsageEvent,
  ModelUsageEvent,
  UsageEventQuality,
  UsageEventRecorder,
  UsageEventStatus,
} from "@radioso/usage-contract";

import type {
  EmbeddingUsageEvent,
  ModelUsageEvent,
  UsageEventRecorder,
} from "@radioso/usage-contract";

export class NoopUsageEventRecorder implements UsageEventRecorder {
  async recordEmbedding(_event: EmbeddingUsageEvent): Promise<void> {}
  async recordModelCall(_event: ModelUsageEvent): Promise<void> {}
}
