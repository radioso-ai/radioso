import { describe, expect, it, vi } from "vitest";

import { ContentPlanProjectionOrchestrator } from "../../src/modules/contentPlanning/services/projectionOrchestrator.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");

const generation = (kind: "bootstrap" | "reprojection") => ({
  id: `generation_${kind}`,
  workspaceId: "workspace_1",
  embeddingSpaceId: "space_1",
  kind,
  state: "building" as const,
  policyVersion: 1,
  horizonFrom: new Date("2026-06-03T12:00:00.000Z"),
  horizonTo: NOW,
  coherentAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const projectionState = (kind: "bootstrap" | "reprojection") => ({
  workspaceId: "workspace_1",
  coherentGenerationId: kind === "reprojection" ? "generation_old" : null,
  targetGenerationId: `generation_${kind}`,
  projectionState: kind === "reprojection" ? "reprojecting" as const : "bootstrapping" as const,
  reason: null,
  discoveryCreatedAt: null,
  discoveryMessageId: null,
  processedThrough: kind === "reprojection" ? new Date("2026-08-02T11:00:00.000Z") : null,
  bootstrapProcessed: null,
  bootstrapTotal: null,
  budgetVersion: 1,
  budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
  embeddingRequestsUsed: 0,
  estimatedSpendMicros: "0",
  leaseToken: null,
  leaseExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

describe("ContentPlanProjectionOrchestrator observability", () => {
  it("records typed bootstrap initialization progress with no population content", async () => {
    const target = generation("bootstrap");
    const state = projectionState("bootstrap");
    const record = vi.fn();
    const projections = {
      findProjectionState: vi.fn(async () => state),
      findGeneration: vi.fn(async () => target),
      claimProjectionLease: vi.fn(async () => ({ ...state, leaseToken: "lease_1" })),
    };
    const orchestrator = new ContentPlanProjectionOrchestrator({
      projections: projections as never,
      discovery: {
        capturePopulationSnapshot: vi.fn(async () => ({ total: 7 })),
        listPopulationSnapshotPage: vi.fn(),
        reconcilePopulationSnapshotProgress: vi.fn(),
        commitPage: vi.fn(),
      },
      historicalTurns: { preparePage: vi.fn() },
      budget: { reserve: vi.fn(), refresh: vi.fn(async () => ({ kind: "granted" as const })) },
      observability: { record },
    });

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: "workspace_1",
      embeddingSpaceId: "space_1",
      now: NOW,
    })).resolves.toEqual({
      kind: "progressed",
      processed: 0,
      total: 7,
      generationId: target.id,
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "bootstrap",
      outcome: "progressed",
      workspaceId: "workspace_1",
      generationId: target.id,
      projectionState: "bootstrapping",
      processedCount: 0,
      totalCount: 7,
      durationMs: expect.any(Number),
    }));
  });

  it("records a content-free typed terminal event when orchestration fails", async () => {
    const record = vi.fn();
    const orchestrator = new ContentPlanProjectionOrchestrator({
      projections: {
        findProjectionState: vi.fn(async () => { throw new Error("private visitor question"); }),
      } as never,
      discovery: {
        capturePopulationSnapshot: vi.fn(),
        listPopulationSnapshotPage: vi.fn(),
        reconcilePopulationSnapshotProgress: vi.fn(),
        commitPage: vi.fn(),
      },
      historicalTurns: { preparePage: vi.fn() },
      budget: { reserve: vi.fn() } as never,
      observability: { record },
    });

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: "workspace_1",
      embeddingSpaceId: "space_1",
      now: NOW,
    })).rejects.toThrow("private visitor question");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "discovery",
      outcome: "terminal_failure",
      reason: "projection_tick_failed",
      workspaceId: "workspace_1",
      durationMs: expect.any(Number),
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private visitor question");
  });
});
