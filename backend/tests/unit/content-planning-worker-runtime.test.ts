import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import { buildContentPlanningWorkerRuntime } from "../../src/app/server/dependencyBuilders.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import {
  ContentPlanningWorkerRuntime,
  type ContentPlanningProjectionCandidateSourcePort,
  type ContentPlanningProjectionProcessorPort,
} from "../../src/modules/contentPlanning/services/contentPlanningWorkerRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ContentPlanningWorkerRuntime", () => {
  it("composes without database, embedding, or LLM work during API initialization", () => {
    const embeddingGateway = { embedTexts: vi.fn() };
    const embeddingBindings = {
      resolveBinding: vi.fn(),
      resolveBindingForSpace: vi.fn(),
    };
    const historicalInterpreter = { interpret: vi.fn() };
    const enrichmentInferencePipeline = { complete: vi.fn() };

    buildContentPlanningWorkerRuntime({
      database: { kysely: {} } as never,
      logger: logger as never,
      metricsRegistry: null,
      repositories: {
        contentPlanObservationRepository: {} as never,
        contentPlanProjectionRepository: {} as never,
        contentPlanTopicRepository: {} as never,
        contentPlanEnrichmentRepository: {} as never,
        contentPlanEnrichmentTriggerRepository: {} as never,
      },
      embeddingGateway,
      embeddingBindings: embeddingBindings as never,
      historicalInterpreter: historicalInterpreter as never,
      enrichmentInferencePipeline: enrichmentInferencePipeline as never,
      qualityVerificationSource: { getByAssistantMessageIds: vi.fn() },
    });

    expect(embeddingGateway.embedTexts).not.toHaveBeenCalled();
    expect(embeddingBindings.resolveBinding).not.toHaveBeenCalled();
    expect(embeddingBindings.resolveBindingForSpace).not.toHaveBeenCalled();
    expect(historicalInterpreter.interpret).not.toHaveBeenCalled();
    expect(enrichmentInferencePipeline.complete).not.toHaveBeenCalled();
  });

  it("does no projection or provider work when it is merely constructed", () => {
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn(),
    };
    const orchestrator = { runWorkspaceOnce: vi.fn() };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn(),
      runRetentionOnce: vi.fn(),
    };

    new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger });

    expect(candidates.listCandidates).not.toHaveBeenCalled();
    expect(orchestrator.runWorkspaceOnce).not.toHaveBeenCalled();
    expect(processor.runOnce).not.toHaveBeenCalled();
  });

  it("starts a bounded polling loop, passes the coherent generation to the processor, and stops it", async () => {
    vi.useFakeTimers();
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn().mockResolvedValue([{ workspaceId: "workspace-1", embeddingSpaceId: "space-1" }]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn().mockResolvedValue({ kind: "up_to_date", generationId: "generation-1" }),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn().mockResolvedValue({ claimedCount: 0 }),
      runRetentionOnce: vi.fn().mockResolvedValue({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger }, {
      candidateBatchSize: 2,
      pollIntervalMs: 1_000,
    });

    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(candidates.listCandidates).toHaveBeenCalledOnce();
    expect(candidates.listCandidates).toHaveBeenCalledWith({
      afterWorkspaceId: undefined,
      limit: 2,
      now: expect.any(Date),
    });
    expect(orchestrator.runWorkspaceOnce).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-1",
      now: expect.any(Date),
    });
    expect(processor.runOnce).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      generationId: "generation-1",
    });
    expect(processor.runRetentionOnce).toHaveBeenCalledWith({ workspaceId: "workspace-1" });

    await runtime.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(candidates.listCandidates).toHaveBeenCalledOnce();
  });

  it("contains workspace failures, logs only safe identifiers, and continues the batch", async () => {
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn().mockResolvedValue([
        { workspaceId: "workspace-bad", embeddingSpaceId: "space-bad" },
        { workspaceId: "workspace-good", embeddingSpaceId: "space-good" },
      ]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn()
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValueOnce({ kind: "progressed", generationId: "generation-good", processed: 1, total: 2 }),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn().mockResolvedValue({ claimedCount: 0 }),
      runRetentionOnce: vi.fn().mockResolvedValue({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger });

    await runtime.runOnce();

    expect(processor.runOnce).toHaveBeenCalledWith({
      workspaceId: "workspace-good",
      generationId: "generation-good",
    });
    expect(logger.error).toHaveBeenCalledWith({
      event: "content_planning_projection_tick_failed",
      workspaceId: "workspace-bad",
      reason: "projection_tick_failed",
    }, "Content planning projection tick failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("provider unavailable");
    expect(processor.runRetentionOnce).toHaveBeenCalledTimes(2);
  });

  it("contains retention failures and still processes the next workspace", async () => {
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn().mockResolvedValue([
        { workspaceId: "workspace-bad", embeddingSpaceId: "space-bad" },
        { workspaceId: "workspace-good", embeddingSpaceId: "space-good" },
      ]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn().mockResolvedValue({ kind: "busy" }),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn(),
      runRetentionOnce: vi.fn()
        .mockRejectedValueOnce(new Error("raw source content must not leak"))
        .mockResolvedValueOnce({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger });

    await runtime.runOnce();

    expect(processor.runRetentionOnce).toHaveBeenNthCalledWith(1, { workspaceId: "workspace-bad" });
    expect(processor.runRetentionOnce).toHaveBeenNthCalledWith(2, { workspaceId: "workspace-good" });
    expect(logger.error).toHaveBeenCalledWith({
      event: "content_planning_retention_tick_failed",
      workspaceId: "workspace-bad",
      reason: "retention_tick_failed",
    }, "Content planning retention tick failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("raw source content must not leak");
  });

  it("continues budget-neutral assignment and enrichment work while projection embeddings are paused", async () => {
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn().mockResolvedValue([
        { workspaceId: "workspace-paused", embeddingSpaceId: "space-1" },
      ]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn().mockResolvedValue({
        kind: "budget_paused",
        reason: "daily_budget_exhausted",
        generationId: "generation-1",
      }),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn().mockResolvedValue({ claimedCount: 1 }),
      runRetentionOnce: vi.fn().mockResolvedValue({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger });

    await runtime.runOnce();

    expect(processor.runOnce).toHaveBeenCalledWith({
      workspaceId: "workspace-paused",
      generationId: "generation-1",
    });
  });

  it("keeps idle polling set-based and runs stable-workspace repair only on the maintenance cadence", async () => {
    let now = new Date("2026-08-02T00:00:00.000Z");
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn().mockResolvedValue([]),
      listMaintenanceCandidates: vi.fn().mockResolvedValue([
        { workspaceId: "workspace-stable", embeddingSpaceId: "space-1" },
      ]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn().mockResolvedValue({
        kind: "up_to_date",
        generationId: "generation-1",
      }),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn().mockResolvedValue({ claimedCount: 0 }),
      runRetentionOnce: vi.fn().mockResolvedValue({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger }, {
      clock: () => now,
      maintenanceIntervalMs: 5 * 60_000,
      maintenanceBatchSize: 100,
    });

    await runtime.runOnce();
    now = new Date("2026-08-02T00:04:59.999Z");
    await runtime.runOnce();

    expect(candidates.listCandidates).toHaveBeenCalledTimes(2);
    expect(candidates.listMaintenanceCandidates).not.toHaveBeenCalled();
    expect(orchestrator.runWorkspaceOnce).not.toHaveBeenCalled();
    expect(processor.runRetentionOnce).not.toHaveBeenCalled();

    now = new Date("2026-08-02T00:05:00.000Z");
    await runtime.runOnce();

    expect(candidates.listMaintenanceCandidates).toHaveBeenCalledWith({
      afterWorkspaceId: undefined,
      limit: 100,
    });
    expect(processor.runOnce).toHaveBeenCalledWith({
      workspaceId: "workspace-stable",
      generationId: "generation-1",
      maintenance: true,
    });
    expect(processor.runRetentionOnce).toHaveBeenCalledOnce();

    now = new Date("2026-08-02T00:05:01.000Z");
    await runtime.runOnce();
    expect(candidates.listMaintenanceCandidates).toHaveBeenCalledOnce();
  });

  it("continues a bounded maintenance sweep by cursor without replaying active candidates", async () => {
    let now = new Date("2026-08-02T00:00:00.000Z");
    const candidates: ContentPlanningProjectionCandidateSourcePort = {
      listCandidates: vi.fn()
        .mockResolvedValueOnce([{ workspaceId: "workspace-a", embeddingSpaceId: "space-a" }])
        .mockResolvedValue([]),
      listMaintenanceCandidates: vi.fn()
        .mockResolvedValueOnce([
          { workspaceId: "workspace-a", embeddingSpaceId: "space-a" },
          { workspaceId: "workspace-b", embeddingSpaceId: "space-b" },
        ])
        .mockResolvedValueOnce([
          { workspaceId: "workspace-c", embeddingSpaceId: "space-c" },
        ]),
    };
    const orchestrator = {
      runWorkspaceOnce: vi.fn().mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({ kind: "up_to_date", generationId: `generation-${workspaceId}` })),
    };
    const processor: ContentPlanningProjectionProcessorPort = {
      runOnce: vi.fn().mockResolvedValue({ claimedCount: 0 }),
      runRetentionOnce: vi.fn().mockResolvedValue({ deletedObservationCount: 0 }),
    };
    const runtime = new ContentPlanningWorkerRuntime({ candidates, orchestrator, processor, logger }, {
      clock: () => now,
      maintenanceIntervalMs: 10,
      maintenanceBatchSize: 2,
    });

    await runtime.runOnce();
    now = new Date(now.getTime() + 10);
    await runtime.runOnce();
    now = new Date(now.getTime() + 1);
    await runtime.runOnce();

    expect(candidates.listMaintenanceCandidates).toHaveBeenNthCalledWith(1, {
      afterWorkspaceId: undefined,
      limit: 2,
    });
    expect(candidates.listMaintenanceCandidates).toHaveBeenNthCalledWith(2, {
      afterWorkspaceId: "workspace-b",
      limit: 2,
    });
    expect(orchestrator.runWorkspaceOnce.mock.calls.map(([input]) => input.workspaceId)).toEqual([
      "workspace-a",
      "workspace-a",
      "workspace-b",
      "workspace-c",
    ]);
    expect(processor.runOnce).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-a",
      maintenance: true,
    }));
  });
});

describe("document worker lifecycle", () => {
  it("is the only runtime that starts and stops content planning processing", async () => {
    const contentPlanningWorkerRuntime = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const dependencies = {
      logger,
      applicationModules: {
        initializeAll: vi.fn().mockResolvedValue(undefined),
        shutdownAll: vi.fn().mockResolvedValue(undefined),
      },
      documentProcessingWorker: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      actionDispatchWorker: {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      contentPlanningWorkerRuntime,
    } as unknown as AppDependencies;
    const env = {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      DB_MIGRATION_LOCK_TIMEOUT_MS: 1_000,
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: 2_000,
      NODE_ENV: "test",
      OBSERVABILITY_SERVICE_NAME: "radioso-api",
      OTEL_ENABLED: false,
      OTEL_LOGS_ENABLED: false,
    } as Env;

    const runtime = await startWorkerRuntime({
      env,
      logger: logger as never,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
    });

    expect(contentPlanningWorkerRuntime.start).toHaveBeenCalledOnce();
    await runtime.shutdown("test");
    expect(contentPlanningWorkerRuntime.stop).toHaveBeenCalledOnce();
  });
});
