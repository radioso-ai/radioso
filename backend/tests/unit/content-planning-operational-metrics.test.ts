import { describe, expect, it, vi } from "vitest";

import { ContentPlanningOperationalMetricsReporter } from "../../src/modules/contentPlanning/services/operationalMetricsReporter.js";

describe("ContentPlanningOperationalMetricsReporter", () => {
  it("publishes one content-free snapshot with exact backlog, lag, progress, and lifecycle counts", async () => {
    const record = vi.fn();
    const reporter = new ContentPlanningOperationalMetricsReporter({
      source: {
        load: vi.fn(async () => ({
          projectionKind: "reprojection" as const,
          projectionState: "reprojecting" as const,
          processedThrough: new Date("2026-08-02T11:58:30.000Z"),
          processedCount: 30,
          totalCount: 120,
          pendingObservationCount: 9,
          pendingEmbeddingCount: 4,
          pendingAssignmentCount: 3,
          pendingEnrichmentCount: 2,
          provisionalTopicCount: 5,
          matureTopicCount: 8,
          mergedTopicCount: 1,
        })),
      },
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(reporter.capture({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    })).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith({
      stage: "projection_snapshot",
      outcome: "completed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
      projectionKind: "reprojection",
      projectionState: "reprojecting",
      processedCount: 30,
      totalCount: 120,
      projectionLagSeconds: 90,
      pendingObservationCount: 9,
      pendingEmbeddingCount: 4,
      pendingAssignmentCount: 3,
      pendingEnrichmentCount: 2,
      provisionalTopicCount: 5,
      matureTopicCount: 8,
      mergedTopicCount: 1,
    });
  });

  it("contains snapshot failures and emits only a typed reason", async () => {
    const record = vi.fn();
    const reporter = new ContentPlanningOperationalMetricsReporter({
      source: { load: vi.fn(async () => { throw new Error("private visitor question"); }) },
      observability: { record },
    });

    await expect(reporter.capture({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    })).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith({
      stage: "projection_snapshot",
      outcome: "skipped",
      reason: "operational_snapshot_failed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("private visitor question");
  });
});
