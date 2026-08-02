import { describe, expect, it, vi } from "vitest";

import { PostgresContentPlanningOperationalMetricsSource } from "../../src/modules/contentPlanning/infra/postgresOperationalMetricsSource.js";

describe("PostgresContentPlanningOperationalMetricsSource", () => {
  it("loads one scalar-only workspace snapshot without returning source content", async () => {
    const executeQuery = vi.fn(async () => ({
      rows: [{
        projection_kind: "reprojection",
        projection_state: "updating",
        processed_through: new Date("2026-08-02T11:59:00.000Z"),
        bootstrap_processed: "42",
        bootstrap_total: "100",
        pending_observation_count: "9",
        pending_embedding_count: "4",
        pending_assignment_count: "3",
        pending_enrichment_count: "2",
        provisional_topic_count: "6",
        mature_topic_count: "8",
        merged_topic_count: "1",
      }],
    }));
    const source = new PostgresContentPlanningOperationalMetricsSource({ executeQuery } as never);

    await expect(source.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    })).resolves.toEqual({
      projectionKind: "reprojection",
      projectionState: "updating",
      processedThrough: new Date("2026-08-02T11:59:00.000Z"),
      processedCount: 42,
      totalCount: 100,
      pendingObservationCount: 9,
      pendingEmbeddingCount: 4,
      pendingAssignmentCount: 3,
      pendingEnrichmentCount: 2,
      provisionalTopicCount: 6,
      matureTopicCount: 8,
      mergedTopicCount: 1,
    });
    expect(executeQuery).toHaveBeenCalledOnce();
    expect(JSON.stringify(await source.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    }))).not.toContain("question");
    expect(executeQuery).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining(
        "enrichment.topic_id IS NULL\n                 AND topic.enrichment_dirty_at IS NOT NULL",
      ),
    }));
  });
});
