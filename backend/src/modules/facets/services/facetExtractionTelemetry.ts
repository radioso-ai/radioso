import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";

type FacetExtractionTelemetryEventType =
  | "facet.extraction.job_completed"
  | "facet.extraction.job_failed"
  | "facet.extraction.job_skipped";

type FacetExtractionTelemetryOutcome =
  | "completed"
  | "skipped"
  | "retry_scheduled"
  | "failed"
  | "failed_permanent";

interface FacetExtractionTelemetryInput {
  durationMs: number;
  outcome: FacetExtractionTelemetryOutcome;
  reason?: string;
}

/**
 * The one telemetry shape every facet extraction run emits, however it was claimed: the
 * workspace-scoped drain worker and the generic background-job handler both call this instead
 * of duplicating the event shape.
 */
export const emitFacetExtractionTelemetry = async (
  telemetryService: Pick<TelemetryService, "emit"> | undefined,
  eventType: FacetExtractionTelemetryEventType,
  job: { id: string; workspaceId: string; attemptCount: number },
  input: FacetExtractionTelemetryInput,
): Promise<void> => {
  await telemetryService?.emit({
    eventType,
    severity: eventType === "facet.extraction.job_failed" ? "error" : "info",
    correlation: { workspaceId: job.workspaceId, jobId: job.id },
    metrics: { durationMs: input.durationMs, attemptCount: job.attemptCount },
    metadata: input.reason ? { reason: input.reason } : undefined,
    tags: { outcome: input.outcome },
  });
};
