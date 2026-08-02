import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
} from "./contentPlanWorkerObservability.js";

export interface ContentPlanCorpusInvalidationDrainResult {
  invalidatedCount: number;
  pending: boolean;
  markerRevision: string | null;
}

export interface ContentPlanCorpusInvalidationRepositoryPort {
  markWorkspaceDirty(input: { workspaceId: string; dirtyAt: Date }): Promise<void>;
  drainWorkspace(input: {
    workspaceId: string;
    limit: number;
  }): Promise<ContentPlanCorpusInvalidationDrainResult>;
}

/** Adds safe stage-level observability around the bounded durable fanout. */
export class ContentPlanCorpusInvalidationFanout {
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(
    private readonly repository: Pick<ContentPlanCorpusInvalidationRepositoryPort, "drainWorkspace">,
    observability?: ContentPlanWorkerEventSink,
  ) {
    this.observability = observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
  }

  async runOnce(input: { workspaceId: string; limit: number }): Promise<ContentPlanCorpusInvalidationDrainResult> {
    const startedAt = Date.now();
    try {
      const result = await this.repository.drainWorkspace(input);
      this.observability.record({
        stage: "corpus_invalidation",
        outcome: result.invalidatedCount === 0 ? "skipped" : "completed",
        workspaceId: input.workspaceId,
        itemCount: result.invalidatedCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return result;
    } catch (error) {
      this.observability.record({
        stage: "corpus_invalidation",
        outcome: "retry_scheduled",
        reason: "corpus_invalidation_failed",
        workspaceId: input.workspaceId,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      throw error;
    }
  }
}
