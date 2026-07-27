import type {
  EmbeddingProfileRepositoryPort,
  VectorIndexWorkRepositoryPort,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import type {
  EmbeddingTransitionCoordinator,
} from "../../modules/embeddingProfiles/public.js";
import type {
  EmbeddingTransitionIndexPreparationPort,
} from "./embeddingModelTransitionAdapter.js";
import type {
  VectorAdapter,
} from "../../modules/retrieval/domain/vectorAdapter.js";
import type {
  VectorIndexReconciler,
} from "../../modules/retrieval/services/vectorIndexReconciler.js";

export const PGVECTOR_BACKEND_KEY = "pgvector";

type EmbeddingTransitionMaintenancePort = Pick<
  EmbeddingTransitionCoordinator,
  "reconcileBackfills"
> & {
  promotePendingEmbeddingModelIfReady(
    workspaceId: string,
  ): Promise<unknown>;
};

type BackfillReconciliationOutcome = Awaited<
  ReturnType<EmbeddingTransitionCoordinator["reconcileBackfills"]>
>;

export class PgVectorTransitionIndexPreparation
implements EmbeddingTransitionIndexPreparationPort {
  constructor(
    private readonly adapter: Pick<VectorAdapter, "admin">,
    private readonly checkpoints: Pick<
      VectorIndexWorkRepositoryPort,
      "ensureCheckpoint"
    >,
  ) {}

  async prepare(
    input: Parameters<EmbeddingTransitionIndexPreparationPort["prepare"]>[0],
  ): Promise<void> {
    await this.adapter.admin.prepareSpace({ space: input.space });
    await this.checkpoints.ensureCheckpoint({
      backendKey: PGVECTOR_BACKEND_KEY,
      workspaceId: input.workspaceId,
      embeddingSpaceId: input.space.id,
      // Pgvector exact search reads canonical chunk_embeddings in the same
      // PostgreSQL system of record. No separate approximate-index build is
      // required before this correctness-preserving route is usable.
      readiness: "exact_fallback",
    });
  }
}

export class PgVectorTransitionMaintenance {
  private backfillReconciliationFailureActive = false;

  constructor(
    private readonly reconciler: Pick<VectorIndexReconciler, "runUntilIdle">,
    private readonly profiles: Pick<
      EmbeddingProfileRepositoryPort,
      "listBuildingTransitions"
    >,
    private readonly transitions: EmbeddingTransitionMaintenancePort,
    private readonly onBackfillReconciliationFailure?: (
      outcome: BackfillReconciliationOutcome,
    ) => void,
  ) {}

  async run(input: {
    maxBatches: number;
    workspaceId?: string;
  }): Promise<void> {
    try {
      await this.reconciler.runUntilIdle(input.maxBatches);
    } finally {
      if (input.workspaceId) {
        await this.transitions.promotePendingEmbeddingModelIfReady(
          input.workspaceId,
        );
      } else {
        await this.reconcileBuildingTransitions();
      }
    }
  }

  async reconcileBuildingTransitions(limit = 100): Promise<void> {
    const backfills = await this.transitions.reconcileBackfills({ limit });
    if (backfills.failed === 0) {
      this.backfillReconciliationFailureActive = false;
    } else if (!this.backfillReconciliationFailureActive) {
      this.backfillReconciliationFailureActive = true;
      this.onBackfillReconciliationFailure?.(backfills);
    }
    const building = await this.profiles.listBuildingTransitions({ limit });
    for (const { profile } of building) {
      await this.transitions.promotePendingEmbeddingModelIfReady(
        profile.workspaceId,
      );
    }
  }
}
