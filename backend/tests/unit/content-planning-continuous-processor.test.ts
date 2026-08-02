import { describe, expect, it, vi } from "vitest";

import { ContinuousContentPlanningProcessor } from "../../src/modules/contentPlanning/services/continuousContentPlanningProcessor.js";

describe("ContinuousContentPlanningProcessor", () => {
  it("runs scheduling and enrichment after projection while isolating partial failures", async () => {
    const projection = {
      runOnce: vi.fn(async () => ({ assignedCount: 1 })),
      runRetentionOnce: vi.fn(async () => ({ deletedCount: 0 })),
    };
    const planning = { runOnce: vi.fn(async () => { throw new Error("corpus unavailable"); }) };
    const enrichments = {
      runOnce: vi.fn(async () => ({
        claimedCount: 1,
        outcomes: {
          published: 0,
          stale: 0,
          retry_scheduled: 0,
          terminal_failure: 0,
        },
      })),
    };
    const warn = vi.fn();
    const operationalMetrics = { capture: vi.fn(async () => undefined) };
    const freshness = { refreshProjectionFreshness: vi.fn(async () => null) };
    const processor = new ContinuousContentPlanningProcessor({
      projection,
      freshness,
      planning,
      enrichments,
      operationalMetrics,
      logger: { warn },
    });

    await expect(processor.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .resolves.toEqual({ assignedCount: 1 });
    expect(planning.runOnce).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      forceRepair: false,
    });
    expect(enrichments.runOnce).toHaveBeenCalledOnce();
    expect(freshness.refreshProjectionFreshness).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      now: expect.any(Date),
      delayedAfterMs: 120_000,
      scanLimit: 100,
    });
    expect(operationalMetrics.capture).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    });
    expect(warn).toHaveBeenCalledWith({
      event: "content_planning_enrichment_schedule_failed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
      reason: "schedule_failed",
    }, "Content planning enrichment scheduling failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("corpus unavailable");
  });

  it("refreshes durable freshness even when a projection tick throws", async () => {
    const projection = {
      runOnce: vi.fn(async () => { throw new Error("projection failed"); }),
      runRetentionOnce: vi.fn(),
    };
    const freshness = { refreshProjectionFreshness: vi.fn(async () => null) };
    const processor = new ContinuousContentPlanningProcessor({
      projection,
      freshness,
      planning: { runOnce: vi.fn() },
      enrichments: { runOnce: vi.fn() },
      logger: { warn: vi.fn() },
    }, { clock: () => new Date("2026-08-02T12:00:00.000Z") });

    await expect(processor.runOnce({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    })).rejects.toThrow("projection failed");
    expect(freshness.refreshProjectionFreshness).toHaveBeenCalledOnce();
  });

  it("keeps per-message projection current while cadencing full repair and retention work", async () => {
    let now = new Date("2026-08-02T12:00:00.000Z");
    const projection = {
      runOnce: vi.fn(async () => ({ assignedCount: 0 })),
      runRetentionOnce: vi.fn(async () => ({ deletedCount: 0 })),
    };
    const planning = {
      runOnce: vi.fn(async () => ({ kind: "skipped" as const, dirtyTopicCount: 0 })),
    };
    const enrichments = {
      runOnce: vi.fn(async () => ({
        claimedCount: 0,
        outcomes: { published: 0, stale: 0, retry_scheduled: 0, terminal_failure: 0 },
      })),
    };
    const processor = new ContinuousContentPlanningProcessor({
      projection,
      planning,
      enrichments,
      logger: { warn: vi.fn() },
    }, {
      clock: () => now,
      repairIntervalMs: 5 * 60_000,
      retentionIntervalMs: 5 * 60_000,
    });

    await processor.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" });
    now = new Date("2026-08-02T12:00:01.000Z");
    await processor.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" });
    now = new Date("2026-08-02T12:05:00.000Z");
    await processor.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" });

    expect(projection.runOnce).toHaveBeenCalledTimes(3);
    expect(planning.runOnce).toHaveBeenNthCalledWith(1, expect.objectContaining({ forceRepair: false }));
    expect(planning.runOnce).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRepair: false }));
    expect(planning.runOnce).toHaveBeenNthCalledWith(3, expect.objectContaining({ forceRepair: true }));
    expect(enrichments.runOnce).toHaveBeenCalledTimes(3);

    await expect(processor.runRetentionOnce({ workspaceId: "workspace_1" }))
      .resolves.toEqual({ deletedCount: 0 });
    now = new Date("2026-08-02T12:05:01.000Z");
    await expect(processor.runRetentionOnce({ workspaceId: "workspace_1" }))
      .resolves.toEqual({ kind: "skipped", reason: "retention_cadence" });
    now = new Date("2026-08-02T12:10:00.000Z");
    await processor.runRetentionOnce({ workspaceId: "workspace_1" });
    expect(projection.runRetentionOnce).toHaveBeenCalledTimes(2);
  });

  it("does not schedule without a resolved workspace generation and delegates retention", async () => {
    const projection = {
      runOnce: vi.fn(async () => null),
      runRetentionOnce: vi.fn(async () => ({ deletedCount: 1 })),
    };
    const planning = { runOnce: vi.fn() };
    const enrichments = { runOnce: vi.fn() };
    const processor = new ContinuousContentPlanningProcessor({
      projection,
      planning,
      enrichments,
      logger: { warn: vi.fn() },
    });

    await processor.runOnce({});
    expect(planning.runOnce).not.toHaveBeenCalled();
    await expect(processor.runRetentionOnce({ workspaceId: "workspace_1" }))
      .resolves.toEqual({ deletedCount: 1 });
  });
});
