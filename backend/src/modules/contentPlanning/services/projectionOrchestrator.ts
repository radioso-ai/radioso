import { randomUUID } from "node:crypto";

import type {
  QualityContentPlanningPopulationCursor,
} from "../../quality/contracts/contentPlanningEvidence.js";
import type {
  ContentPlanProjectionBudgetPort,
  ContentPlanProjectionDiscoveryPort,
  ContentPlanProjectionGenerationRecord,
  ContentPlanProjectionRepositoryPort,
  ContentPlanProjectionStateRecord,
} from "../contracts/persistence.js";
import type { ContentPlanHistoricalTurnProjectionPort } from "./historicalTurnProjectionService.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
  type ContentPlanWorkerStage,
} from "./contentPlanWorkerObservability.js";
import { utcBudgetWindowStart } from "./projectionBudgetService.js";

export const CONTENT_PLAN_PROJECTION_HORIZON_DAYS = 60;
const HORIZON_MS = CONTENT_PLAN_PROJECTION_HORIZON_DAYS * 24 * 60 * 60 * 1_000;

export interface ContentPlanProjectionOrchestratorOptions {
  pageSize?: number;
  leaseMs?: number;
  policyVersion?: number;
  budgetVersion?: number;
  idFactory?: () => string;
}

export type ContentPlanProjectionOrchestrationResult =
  | { kind: "up_to_date"; generationId: string }
  | { kind: "busy" }
  | { kind: "budget_paused"; reason: "daily_budget_exhausted"; generationId: string }
  | { kind: "progressed"; processed: number; total: number; generationId: string }
  | { kind: "awaiting_projection"; processed: number; total: number; generationId: string }
  | { kind: "promoted"; generationId: string };

interface ProjectionTarget {
  generation: ContentPlanProjectionGenerationRecord;
  state: ContentPlanProjectionStateRecord;
}

const progressNumber = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Content planning projection progress exceeds safe bounds");
  }
  return parsed;
};

export class ContentPlanProjectionOrchestrator {
  private readonly pageSize: number;
  private readonly leaseMs: number;
  private readonly policyVersion: number;
  private readonly budgetVersion: number;
  private readonly idFactory: () => string;
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(
    private readonly dependencies: {
      projections: ContentPlanProjectionRepositoryPort;
      discovery: ContentPlanProjectionDiscoveryPort;
      historicalTurns: ContentPlanHistoricalTurnProjectionPort;
      budget: ContentPlanProjectionBudgetPort & {
        refresh?(input: {
          workspaceId: string;
          generationId: string;
          now: Date;
        }): Promise<{ kind: "granted" } | { kind: "budget_paused"; reason: "daily_budget_exhausted" }>;
      };
      observability?: ContentPlanWorkerEventSink;
    },
    options: ContentPlanProjectionOrchestratorOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 25;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.policyVersion = options.policyVersion ?? 1;
    this.budgetVersion = options.budgetVersion ?? 1;
    this.idFactory = options.idFactory ?? randomUUID;
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
    for (const value of [this.pageSize, this.leaseMs, this.policyVersion, this.budgetVersion]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Content planning projection options must be positive safe integers");
      }
    }
  }

  async runWorkspaceOnce(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    now?: Date;
  }): Promise<ContentPlanProjectionOrchestrationResult> {
    const startedAt = Date.now();
    try {
      return await this.runWorkspaceOnceInternal(input, startedAt);
    } catch (error) {
      this.observability.record({
        stage: "discovery",
        outcome: "terminal_failure",
        reason: "projection_tick_failed",
        workspaceId: input.workspaceId,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      throw error;
    }
  }

  private async runWorkspaceOnceInternal(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    now?: Date;
  }, startedAt: number): Promise<ContentPlanProjectionOrchestrationResult> {
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Content planning projection requires a valid time");
    }
    const target = await this.resolveTarget({ ...input, now });
    if (target.kind === "coherent") {
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: { kind: "up_to_date", generationId: target.generation.id },
        startedAt,
      });
    }

    const refreshed = this.dependencies.budget.refresh
      ? await this.dependencies.budget.refresh({
          workspaceId: input.workspaceId,
          generationId: target.generation.id,
          now,
        })
      : { kind: "granted" as const };
    if (refreshed.kind === "budget_paused") {
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: { ...refreshed, generationId: target.generation.id },
        startedAt,
      });
    }

    const latestState = await this.dependencies.projections.findProjectionState(input.workspaceId);
    if (!latestState || latestState.targetGenerationId !== target.generation.id) {
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: { kind: "busy" },
        startedAt,
      });
    }
    if (latestState.bootstrapProcessed === null || latestState.bootstrapTotal === null) {
      const result = await this.initializeTargetProgress({
        workspaceId: input.workspaceId,
        generation: target.generation,
        now,
      });
      return this.recordProjectionResult({ input, generation: target.generation, result, startedAt });
    }
    const processed = progressNumber(latestState.bootstrapProcessed);
    const total = progressNumber(latestState.bootstrapTotal);
    if (processed === total) {
      const result = await this.tryPromote({
        workspaceId: input.workspaceId,
        generation: target.generation,
        state: latestState,
        processed,
        total,
        now,
      });
      return this.recordProjectionResult({ input, generation: target.generation, result, startedAt });
    }

    const lease = await this.dependencies.projections.claimProjectionLease({
      workspaceId: input.workspaceId,
      now,
      leaseMs: this.leaseMs,
    });
    if (!lease?.leaseToken || lease.targetGenerationId !== target.generation.id) {
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: { kind: "busy" },
        startedAt,
      });
    }
    const window = {
      from: target.generation.horizonFrom.toISOString(),
      to: target.generation.horizonTo.toISOString(),
    };
    const cursor: QualityContentPlanningPopulationCursor | undefined =
      lease.discoveryCreatedAt && lease.discoveryMessageId
        ? {
            createdAt: lease.discoveryCreatedAt.toISOString(),
            assistantMessageId: lease.discoveryMessageId,
            windowFrom: window.from,
            windowTo: window.to,
          }
        : undefined;
    const page = await this.dependencies.discovery.listPopulationSnapshotPage({
      workspaceId: input.workspaceId,
      generationId: target.generation.id,
      window,
      cursor,
      limit: this.pageSize,
    });
    if (page.items.length === 0) {
      const reconciled = await this.dependencies.discovery.reconcilePopulationSnapshotProgress({
        workspaceId: input.workspaceId,
        generationId: target.generation.id,
        leaseToken: lease.leaseToken,
        ...(cursor
          ? {
              cursor: {
                createdAt: new Date(cursor.createdAt),
                assistantMessageId: cursor.assistantMessageId,
              },
            }
          : {}),
        processed,
      });
      if (!reconciled) {
        return this.recordProjectionResult({
          input,
          generation: target.generation,
          result: { kind: "busy" },
          startedAt,
        });
      }
      if (reconciled.processed === reconciled.total) {
        const state = await this.dependencies.projections.findProjectionState(input.workspaceId);
        if (state) {
          const result = await this.tryPromote({
            workspaceId: input.workspaceId,
            generation: target.generation,
            state,
            processed: reconciled.processed,
            total: reconciled.total,
            now,
          });
          return this.recordProjectionResult({ input, generation: target.generation, result, startedAt });
        }
      }
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: {
          kind: "awaiting_projection",
          processed: reconciled.processed,
          total: reconciled.total,
          generationId: target.generation.id,
        },
        startedAt,
      });
    }

    let prepared: Awaited<ReturnType<ContentPlanHistoricalTurnProjectionPort["preparePage"]>>;
    try {
      prepared = await this.dependencies.historicalTurns.preparePage({
        workspaceId: input.workspaceId,
        generationId: target.generation.id,
        turns: page.items,
        now,
      });
      if (prepared.kind === "budget_paused") {
        await this.dependencies.projections.releaseProjectionLease({
          workspaceId: input.workspaceId,
          leaseToken: lease.leaseToken,
        });
        return this.recordProjectionResult({
          input,
          generation: target.generation,
          result: { ...prepared, generationId: target.generation.id },
          startedAt,
        });
      }
      const nextProcessed = Math.min(total, processed + page.items.length);
      const last = page.items.at(-1)!;
      const discovery = await this.dependencies.discovery.commitPage({
        workspaceId: input.workspaceId,
        generationId: target.generation.id,
        leaseToken: lease.leaseToken,
        turns: prepared.turns,
        cursor: {
          createdAt: new Date(last.createdAt),
          assistantMessageId: last.assistantMessageId,
        },
        processed: nextProcessed,
        total,
      });
      this.observability.record({
        stage: "discovery",
        outcome: "completed",
        workspaceId: input.workspaceId,
        generationId: target.generation.id,
        itemCount: discovery.acceptedCount + discovery.duplicateCount + discovery.excludedCount,
      });

      if (nextProcessed === total) {
        const state = await this.dependencies.projections.findProjectionState(input.workspaceId);
        if (state) {
          const result = await this.tryPromote({
            workspaceId: input.workspaceId,
            generation: target.generation,
            state,
            processed: nextProcessed,
            total,
            now,
          });
          return this.recordProjectionResult({ input, generation: target.generation, result, startedAt });
        }
      }
      return this.recordProjectionResult({
        input,
        generation: target.generation,
        result: {
          kind: "progressed",
          processed: nextProcessed,
          total,
          generationId: target.generation.id,
        },
        startedAt,
      });
    } catch (error) {
      await this.dependencies.projections.releaseProjectionLease({
        workspaceId: input.workspaceId,
        leaseToken: lease.leaseToken,
      }).catch(() => undefined);
      throw error;
    }
  }

  private recordProjectionResult<Result extends ContentPlanProjectionOrchestrationResult>(input: {
    input: { workspaceId: string };
    generation: ContentPlanProjectionGenerationRecord;
    result: Result;
    startedAt: number;
  }): Result {
    const stage = projectionStage(input.generation.kind);
    const projectionState = input.result.kind === "promoted" || input.result.kind === "up_to_date"
      ? "ready" as const
      : input.result.kind === "budget_paused"
        ? "budget_paused" as const
        : stage === "reprojection"
          ? "reprojecting" as const
          : stage === "bootstrap"
            ? "bootstrapping" as const
            : "updating" as const;
    this.observability.record({
      stage,
      outcome: input.result.kind,
      workspaceId: input.input.workspaceId,
      generationId: "generationId" in input.result
        ? input.result.generationId
        : input.generation.id,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      projectionState,
      ...(input.result.kind === "progressed" || input.result.kind === "awaiting_projection"
        ? { processedCount: input.result.processed, totalCount: input.result.total }
        : {}),
    });
    return input.result;
  }

  private async initializeTargetProgress(input: {
    workspaceId: string;
    generation: ContentPlanProjectionGenerationRecord;
    now: Date;
  }): Promise<ContentPlanProjectionOrchestrationResult> {
    const lease = await this.dependencies.projections.claimProjectionLease({
      workspaceId: input.workspaceId,
      now: input.now,
      leaseMs: this.leaseMs,
    });
    if (!lease?.leaseToken || lease.targetGenerationId !== input.generation.id) {
      return { kind: "busy" };
    }
    try {
      const initialized = await this.dependencies.discovery.capturePopulationSnapshot({
        workspaceId: input.workspaceId,
        generationId: input.generation.id,
        leaseToken: lease.leaseToken,
        window: {
          from: input.generation.horizonFrom.toISOString(),
          to: input.generation.horizonTo.toISOString(),
        },
      });
      if (!initialized) return { kind: "busy" };
      return {
        kind: "progressed",
        processed: 0,
        total: initialized.total,
        generationId: input.generation.id,
      };
    } catch (error) {
      await this.dependencies.projections.releaseProjectionLease({
        workspaceId: input.workspaceId,
        leaseToken: lease.leaseToken,
      }).catch(() => undefined);
      throw error;
    }
  }

  private async resolveTarget(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    now: Date;
  }) {
    const state = await this.dependencies.projections.findProjectionState(input.workspaceId);
    if (state?.targetGenerationId) {
      const target = await this.dependencies.projections.findGeneration(
        state.targetGenerationId,
        input.workspaceId,
      );
      if (
        target?.state === "building"
        && target.embeddingSpaceId === input.embeddingSpaceId
      ) {
        return { kind: "target" as const, generation: target };
      }
    }
    if (state?.coherentGenerationId && !state.targetGenerationId) {
      const coherent = await this.dependencies.projections.findGeneration(
        state.coherentGenerationId,
        input.workspaceId,
      );
      if (
        coherent?.state === "coherent"
        && coherent.embeddingSpaceId === input.embeddingSpaceId
      ) {
        return { kind: "coherent" as const, generation: coherent };
      }
    }

    const horizonTo = new Date(input.now);
    const horizonFrom = new Date(horizonTo.getTime() - HORIZON_MS);
    return this.dependencies.projections.ensureTargetGeneration({
      workspaceId: input.workspaceId,
      embeddingSpaceId: input.embeddingSpaceId,
      generationId: this.idFactory(),
      policyVersion: this.policyVersion,
      horizonFrom,
      horizonTo,
      total: null,
      budgetVersion: this.budgetVersion,
      budgetWindowStartedAt: utcBudgetWindowStart(input.now),
    });
  }

  private async tryPromote(input: {
    workspaceId: string;
    generation: ContentPlanProjectionGenerationRecord;
    state: ContentPlanProjectionStateRecord;
    processed: number;
    total: number;
    now: Date;
  }): Promise<ContentPlanProjectionOrchestrationResult> {
    const lease = await this.dependencies.projections.claimProjectionLease({
      workspaceId: input.workspaceId,
      now: input.now,
      leaseMs: this.leaseMs,
    });
    if (!lease?.leaseToken) {
      return { kind: "busy" };
    }
    const promoted = await this.dependencies.projections.promoteGeneration({
      workspaceId: input.workspaceId,
      targetGenerationId: input.generation.id,
      expectedCoherentGenerationId: input.state.coherentGenerationId,
      leaseToken: lease.leaseToken,
      coherentAt: input.now,
      processedThrough: input.generation.horizonTo,
    });
    if (promoted) {
      return { kind: "promoted", generationId: input.generation.id };
    }
    await this.dependencies.projections.releaseProjectionLease({
      workspaceId: input.workspaceId,
      leaseToken: lease.leaseToken,
    });
    return {
      kind: "awaiting_projection",
      processed: input.processed,
      total: input.total,
      generationId: input.generation.id,
    };
  }
}

const projectionStage = (
  kind: ContentPlanProjectionGenerationRecord["kind"],
): ContentPlanWorkerStage => kind === "reprojection"
  ? "reprojection"
  : kind === "bootstrap"
    ? "bootstrap"
    : "discovery";
