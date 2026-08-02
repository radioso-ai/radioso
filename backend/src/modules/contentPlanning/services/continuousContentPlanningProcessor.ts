import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ContentPlanningProjectionProcessorPort } from "./contentPlanningWorkerRuntime.js";
import type { ContentPlanningEnrichmentJobRunner } from "./enrichmentJobRunner.js";
import type { ContentPlanningEnrichmentPlanningService } from "./enrichmentPlanningService.js";
import type { ContentPlanningOperationalMetricsReporter } from "./operationalMetricsReporter.js";

type ProjectionProcessor = ContentPlanningProjectionProcessorPort;
type PlanningService = Pick<ContentPlanningEnrichmentPlanningService, "runOnce">;
type EnrichmentRunner = Pick<ContentPlanningEnrichmentJobRunner, "runOnce">;
type OperationalMetricsReporter = Pick<ContentPlanningOperationalMetricsReporter, "capture">;

export interface ContinuousContentPlanningProcessorOptions {
  clock?: () => Date;
  repairIntervalMs?: number;
  retentionIntervalMs?: number;
}

const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps projection evidence available even when corpus or model enrichment is
 * degraded. Every error log is deliberately content-free and bounded.
 */
export class ContinuousContentPlanningProcessor implements ContentPlanningProjectionProcessorPort {
  private readonly clock: () => Date;
  private readonly repairIntervalMs: number;
  private readonly retentionIntervalMs: number;
  private readonly lastRepairAttemptByProjection = new Map<string, number>();
  private readonly lastRetentionAttemptByWorkspace = new Map<string, number>();

  constructor(
    private readonly dependencies: {
      projection: ProjectionProcessor;
      planning: PlanningService;
      enrichments: EnrichmentRunner;
      operationalMetrics?: OperationalMetricsReporter;
      logger: Pick<AppLogger, "warn">;
    },
    options: ContinuousContentPlanningProcessorOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.repairIntervalMs = options.repairIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.retentionIntervalMs = options.retentionIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (!Number.isSafeInteger(this.repairIntervalMs) || this.repairIntervalMs < 1
      || !Number.isSafeInteger(this.retentionIntervalMs) || this.retentionIntervalMs < 1) {
      throw new Error("Content planning maintenance intervals are invalid");
    }
  }

  async runOnce(input: {
    workspaceId?: string;
    generationId?: string;
    maintenance?: boolean;
  }): Promise<unknown> {
    const projection = await this.dependencies.projection.runOnce(input);
    if (!input.workspaceId || !input.generationId) return projection;

    try {
      const forceRepair = input.maintenance === true
        || this.shouldRunRepair(input.workspaceId, input.generationId);
      await this.dependencies.planning.runOnce({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        forceRepair,
      });
    } catch {
      this.dependencies.logger.warn(
        {
          event: "content_planning_enrichment_schedule_failed",
          workspaceId: input.workspaceId,
          generationId: input.generationId,
          reason: "schedule_failed",
        },
        "Content planning enrichment scheduling failed",
      );
    }
    try {
      await this.dependencies.enrichments.runOnce({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
      });
    } catch {
      this.dependencies.logger.warn(
        {
          event: "content_planning_enrichment_batch_failed",
          workspaceId: input.workspaceId,
          generationId: input.generationId,
          reason: "enrichment_batch_failed",
        },
        "Content planning enrichment batch failed",
      );
    }
    if (this.dependencies.operationalMetrics) {
      await this.dependencies.operationalMetrics.capture({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
      }).catch(() => undefined);
    }
    return projection;
  }

  runRetentionOnce(input: { workspaceId: string }): Promise<unknown> {
    const now = this.clock().getTime();
    const lastAttempt = this.lastRetentionAttemptByWorkspace.get(input.workspaceId);
    if (lastAttempt !== undefined && now >= lastAttempt
      && now - lastAttempt < this.retentionIntervalMs) {
      return Promise.resolve({ kind: "skipped" as const, reason: "retention_cadence" as const });
    }
    this.lastRetentionAttemptByWorkspace.set(input.workspaceId, now);
    return this.dependencies.projection.runRetentionOnce(input);
  }

  private shouldRunRepair(workspaceId: string, generationId: string): boolean {
    const key = `${workspaceId}:${generationId}`;
    const now = this.clock().getTime();
    const lastAttempt = this.lastRepairAttemptByProjection.get(key);
    if (lastAttempt === undefined || now < lastAttempt) {
      this.lastRepairAttemptByProjection.set(key, now);
      return false;
    }
    if (now - lastAttempt < this.repairIntervalMs) return false;
    this.lastRepairAttemptByProjection.set(key, now);
    return true;
  }
}
