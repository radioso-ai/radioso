import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  ContentPlanProjectionOrchestrationResult,
  ContentPlanProjectionOrchestrator,
} from "./projectionOrchestrator.js";

export interface ContentPlanningProjectionCandidate {
  workspaceId: string;
  embeddingSpaceId: string;
}

export interface ContentPlanningProjectionCandidateSourcePort {
  /** Workspaces with durable projection, assignment, or enrichment work now. */
  listCandidates(input: {
    afterWorkspaceId?: string;
    limit: number;
    now: Date;
  }): Promise<ContentPlanningProjectionCandidate[]>;
  /** Stable workspaces visited by a slower bounded repair/retention sweep. */
  listMaintenanceCandidates?(input: {
    afterWorkspaceId?: string;
    limit: number;
  }): Promise<ContentPlanningProjectionCandidate[]>;
}

/** Narrow lifecycle boundary around the evolving embedding/assignment processor. */
export interface ContentPlanningProjectionProcessorPort {
  runOnce(input: {
    workspaceId?: string;
    generationId?: string;
    maintenance?: boolean;
  }): Promise<unknown>;
  runRetentionOnce(input: { workspaceId: string }): Promise<unknown>;
}

export interface ContentPlanningCorpusInvalidationFanoutPort {
  runOnce(input: { workspaceId: string; limit: number }): Promise<unknown>;
}

export interface ContentPlanningWorkerRuntimeOptions {
  candidateBatchSize?: number;
  maintenanceBatchSize?: number;
  maintenanceIntervalMs?: number;
  pollIntervalMs?: number;
  corpusInvalidationBatchSize?: number;
  clock?: () => Date;
}

export class ContentPlanningWorkerRuntime {
  private readonly candidateBatchSize: number;
  private readonly maintenanceBatchSize: number;
  private readonly maintenanceIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly corpusInvalidationBatchSize: number;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private afterWorkspaceId: string | undefined;
  private maintenanceAfterWorkspaceId: string | undefined;
  private maintenanceCycleActive = false;
  private nextMaintenanceAtMs: number | undefined;

  constructor(
    private readonly dependencies: {
      candidates: ContentPlanningProjectionCandidateSourcePort;
      orchestrator: Pick<ContentPlanProjectionOrchestrator, "runWorkspaceOnce">;
      processor: ContentPlanningProjectionProcessorPort;
      corpusInvalidations?: ContentPlanningCorpusInvalidationFanoutPort;
      logger: Pick<AppLogger, "error" | "info">;
    },
    options: ContentPlanningWorkerRuntimeOptions = {},
  ) {
    this.candidateBatchSize = options.candidateBatchSize ?? 25;
    this.maintenanceBatchSize = options.maintenanceBatchSize ?? 100;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 5 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.corpusInvalidationBatchSize = options.corpusInvalidationBatchSize ?? 100;
    this.clock = options.clock ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.candidateBatchSize)
      || this.candidateBatchSize < 1
      || this.candidateBatchSize > 100
      || !Number.isSafeInteger(this.maintenanceBatchSize)
      || this.maintenanceBatchSize < 1
      || this.maintenanceBatchSize > 100
      || !Number.isSafeInteger(this.maintenanceIntervalMs)
      || this.maintenanceIntervalMs < 1
      || !Number.isSafeInteger(this.pollIntervalMs)
      || this.pollIntervalMs < 1
      || !Number.isSafeInteger(this.corpusInvalidationBatchSize)
      || this.corpusInvalidationBatchSize < 1
      || this.corpusInvalidationBatchSize > 100
    ) {
      throw new Error("Content planning worker runtime options are invalid");
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  async runOnce(): Promise<void> {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Content planning worker clock returned an invalid time");
    }
    const activeCandidates = await this.loadActiveCandidates(now);
    const maintenanceCandidates = await this.loadMaintenanceCandidates(now);
    const candidates = mergeCandidates(activeCandidates, maintenanceCandidates);

    for (const candidate of candidates) {
      await this.processCandidate(candidate, now);
    }
  }

  private async loadActiveCandidates(now: Date): Promise<ContentPlanningProjectionCandidate[]> {
    let candidates = await this.dependencies.candidates.listCandidates({
      afterWorkspaceId: this.afterWorkspaceId,
      limit: this.candidateBatchSize,
      now,
    });
    if (candidates.length === 0 && this.afterWorkspaceId) {
      this.afterWorkspaceId = undefined;
      candidates = await this.dependencies.candidates.listCandidates({
        afterWorkspaceId: undefined,
        limit: this.candidateBatchSize,
        now,
      });
    }
    this.afterWorkspaceId = candidates.length === this.candidateBatchSize
      ? candidates.at(-1)?.workspaceId
      : undefined;
    return candidates;
  }

  private async loadMaintenanceCandidates(
    now: Date,
  ): Promise<ContentPlanningProjectionCandidate[]> {
    const list = this.dependencies.candidates.listMaintenanceCandidates;
    if (!list) return [];
    if (this.nextMaintenanceAtMs === undefined) {
      this.nextMaintenanceAtMs = now.getTime() + this.maintenanceIntervalMs;
      return [];
    }
    if (!this.maintenanceCycleActive && now.getTime() < this.nextMaintenanceAtMs) {
      return [];
    }
    this.maintenanceCycleActive = true;
    const candidates = await list.call(this.dependencies.candidates, {
      afterWorkspaceId: this.maintenanceAfterWorkspaceId,
      limit: this.maintenanceBatchSize,
    });
    if (candidates.length === this.maintenanceBatchSize) {
      this.maintenanceAfterWorkspaceId = candidates.at(-1)?.workspaceId;
    } else {
      this.maintenanceAfterWorkspaceId = undefined;
      this.maintenanceCycleActive = false;
      this.nextMaintenanceAtMs = now.getTime() + this.maintenanceIntervalMs;
    }
    return candidates;
  }

  private async processCandidate(
    candidate: ContentPlanningProjectionCandidate & { maintenance: boolean },
    now: Date,
  ): Promise<void> {
    if (this.dependencies.corpusInvalidations) {
      try {
        await this.dependencies.corpusInvalidations.runOnce({
          workspaceId: candidate.workspaceId,
          limit: this.corpusInvalidationBatchSize,
        });
      } catch {
        this.dependencies.logger.error(
          {
            event: "content_planning_corpus_invalidation_tick_failed",
            workspaceId: candidate.workspaceId,
            reason: "corpus_invalidation_failed",
          },
          "Content planning corpus invalidation tick failed",
        );
      }
    }
    try {
      const result = await this.dependencies.orchestrator.runWorkspaceOnce({
        workspaceId: candidate.workspaceId,
        embeddingSpaceId: candidate.embeddingSpaceId,
        now,
      });
      const generationId = this.generationIdFrom(result);
      if (generationId) {
        await this.dependencies.processor.runOnce({
          workspaceId: candidate.workspaceId,
          generationId,
          ...(candidate.maintenance ? { maintenance: true } : {}),
        });
      }
      if (result.kind !== "up_to_date" && result.kind !== "busy") {
        this.dependencies.logger.info(
          {
            event: "content_planning_projection_progress",
            workspaceId: candidate.workspaceId,
            embeddingSpaceId: candidate.embeddingSpaceId,
            generationId: this.generationIdFrom(result) ?? undefined,
            outcome: result.kind,
            ...(result.kind === "progressed" || result.kind === "awaiting_projection"
              ? { processed: result.processed, total: result.total }
              : {}),
          },
          "Content planning projection progressed",
        );
      }
    } catch {
      this.dependencies.logger.error(
        {
          event: "content_planning_projection_tick_failed",
          workspaceId: candidate.workspaceId,
          reason: "projection_tick_failed",
        },
        "Content planning projection tick failed",
      );
    }
    try {
      await this.dependencies.processor.runRetentionOnce({
        workspaceId: candidate.workspaceId,
      });
    } catch {
      this.dependencies.logger.error(
        {
          event: "content_planning_retention_tick_failed",
          workspaceId: candidate.workspaceId,
          reason: "retention_tick_failed",
        },
        "Content planning retention tick failed",
      );
    }
  }

  private generationIdFrom(result: ContentPlanProjectionOrchestrationResult): string | null {
    return "generationId" in result ? result.generationId : null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      this.inFlight = this.runOnce()
        .catch(() => {
          this.dependencies.logger.error(
            {
              event: "content_planning_projection_loop_failed",
              reason: "candidate_scan_failed",
            },
            "Content planning projection loop failed",
          );
        })
        .finally(() => {
          this.inFlight = undefined;
          if (this.running) this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}

const mergeCandidates = (
  active: readonly ContentPlanningProjectionCandidate[],
  maintenance: readonly ContentPlanningProjectionCandidate[],
): Array<ContentPlanningProjectionCandidate & { maintenance: boolean }> => {
  const merged = new Map<string, ContentPlanningProjectionCandidate & { maintenance: boolean }>();
  for (const candidate of active) {
    merged.set(candidate.workspaceId, { ...candidate, maintenance: false });
  }
  for (const candidate of maintenance) {
    merged.set(candidate.workspaceId, { ...candidate, maintenance: true });
  }
  return [...merged.values()];
};
