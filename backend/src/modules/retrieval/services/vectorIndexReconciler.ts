import type {
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceRecord,
  VectorIndexCheckpointRecord,
  VectorIndexFailureCode,
  VectorIndexLagRecord,
  VectorIndexReadiness,
  VectorIndexWorkRecord,
  VectorIndexWorkRepositoryPort,
} from "../../embeddingProfiles/contracts/repositories.js";
import type {
  VectorAdapter,
  VectorIndexMutation,
  VectorIndexPayload,
} from "../domain/vectorAdapter.js";
import { normalizeVectorMetadataFilter } from "../domain/vectorFilter.js";

export interface VectorIndexReconcilerOptions {
  adapter: VectorAdapter;
  backendKey: string;
  repository: Pick<
    VectorIndexWorkRepositoryPort,
    | "claimBatch"
    | "markFailed"
    | "markCompletedAndAdvanceCheckpoint"
    | "completeSupersededAndAdvanceCheckpoint"
    | "getLag"
  >;
  spaces: Pick<EmbeddingProfileRepositoryPort, "findEmbeddingSpaceById">;
  clock?: () => Date;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  pollIntervalMs?: number;
  resolveCaughtUpReadiness?: (input: {
    workspaceId: string;
    space: EmbeddingSpaceRecord;
  }) => Promise<VectorIndexReadiness>;
  onCheckpointAdvanced?: (input: {
    workspaceId: string;
    embeddingSpaceId: string;
    readiness: "ready" | "exact_fallback";
  }) => Promise<void>;
  onLoopError?: (error: unknown) => void;
  onIdle?: () => Promise<void>;
}

export class VectorIndexReconciler {
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<boolean> | null = null;

  constructor(private readonly options: VectorIndexReconcilerOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.options.repository.claimBatch({
      limit: this.options.batchSize,
      now: this.clock(),
      leaseMs: this.options.leaseMs,
    });
    if (claimed.length === 0) {
      await this.options.onIdle?.();
      return false;
    }
    for (const work of claimed) {
      await this.process(work);
    }
    return true;
  }

  async runUntilIdle(maxBatches: number): Promise<number> {
    if (
      !Number.isInteger(maxBatches)
      || maxBatches < 1
      || maxBatches > 100
    ) {
      throw new Error("Vector index max batches must be between 1 and 100");
    }
    let nonEmptyBatches = 0;
    while (nonEmptyBatches < maxBatches) {
      const processed = await this.runOnce();
      if (!processed) {
        break;
      }
      nonEmptyBatches += 1;
    }
    return nonEmptyBatches;
  }

  getLag(input: {
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<VectorIndexLagRecord> {
    return this.options.repository.getLag({
      backendKey: this.options.backendKey,
      ...input,
    });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const poll = () => {
      this.running = this.runOnce()
        .catch((error) => {
          this.options.onLoopError?.(error);
          return false;
        })
        .finally(() => {
          this.running = null;
          if (this.timer) {
            this.timer = setTimeout(
              poll,
              this.options.pollIntervalMs ?? 1_000,
            );
          }
        });
    };
    this.timer = setTimeout(poll, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private async process(work: VectorIndexWorkRecord): Promise<void> {
    let checkpoint: VectorIndexCheckpointRecord | null = null;
    let caughtUpReadiness: VectorIndexReadiness = "building";
    try {
      const space = await this.options.spaces.findEmbeddingSpaceById(
        work.embeddingSpaceId,
      );
      if (!space || space.status === "quarantined") {
        throw new InvalidVectorIndexWorkError("embedding space is unavailable");
      }
      const embeddingSpace = {
        id: space.id,
        dimensions: space.dimensions,
        distanceMetric: space.distanceMetric,
      } as const;
      caughtUpReadiness = this.options.resolveCaughtUpReadiness
        ? await this.options.resolveCaughtUpReadiness({
            workspaceId: work.workspaceId,
            space,
          })
        : "building";
      checkpoint = await this.options.repository
        .completeSupersededAndAdvanceCheckpoint({
          id: work.id,
          backendKey: this.options.backendKey,
          workspaceId: work.workspaceId,
          embeddingSpaceId: work.embeddingSpaceId,
          chunkId: work.chunkId,
          caughtUpReadiness,
        });
      if (!checkpoint) {
        await this.options.adapter.admin.prepareSpace({ space: embeddingSpace });
        const mutation = toMutation(work, space);
        const result = await this.options.adapter.writer.applyMutations({
          workspaceId: work.workspaceId,
          space: embeddingSpace,
          mutations: [mutation],
        });
        if (result.mutations.length !== 1) {
          throw new VectorIndexMutationRejectedError();
        }
        checkpoint = await this.options.repository.markCompletedAndAdvanceCheckpoint({
          id: work.id,
          backendKey: this.options.backendKey,
          workspaceId: work.workspaceId,
          embeddingSpaceId: work.embeddingSpaceId,
          chunkId: work.chunkId,
          caughtUpReadiness,
        });
      }
    } catch (error) {
      checkpoint = await this.fail(
        work,
        error instanceof InvalidVectorIndexWorkError
          ? "invalid_work_payload"
          : error instanceof VectorIndexMutationRejectedError
            ? "mutation_rejected"
            : "adapter_unavailable",
        caughtUpReadiness,
      );
    }
    await this.notifyCheckpoint(checkpoint);
  }

  private async notifyCheckpoint(
    checkpoint: VectorIndexCheckpointRecord | null,
  ): Promise<void> {
    if (
      checkpoint
      && (checkpoint.readiness === "ready"
        || checkpoint.readiness === "exact_fallback")
    ) {
      await this.options.onCheckpointAdvanced?.({
        workspaceId: checkpoint.workspaceId,
        embeddingSpaceId: checkpoint.embeddingSpaceId,
        readiness: checkpoint.readiness,
      });
    }
  }

  private async fail(
    work: VectorIndexWorkRecord,
    errorCode: VectorIndexFailureCode,
    caughtUpReadiness: VectorIndexReadiness,
  ): Promise<VectorIndexCheckpointRecord | null> {
    const result = await this.options.repository.markFailed({
      id: work.id,
      errorCode,
      retryAt: new Date(this.clock().getTime() + this.options.retryDelayMs),
      maxAttempts: this.options.maxAttempts,
      backendKey: this.options.backendKey,
      workspaceId: work.workspaceId,
      embeddingSpaceId: work.embeddingSpaceId,
      chunkId: work.chunkId,
      caughtUpReadiness,
    });
    return result.checkpoint;
  }
}

class InvalidVectorIndexWorkError extends Error {}
class VectorIndexMutationRejectedError extends Error {}

const toMutation = (
  work: VectorIndexWorkRecord,
  space: EmbeddingSpaceRecord,
): VectorIndexMutation => {
  if (work.operation === "delete") {
    return {
      kind: "delete",
      chunkId: work.chunkId,
      version: work.canonicalVersion,
    };
  }
  const vector = numberArray(work.payload.vector);
  if (
    !work.documentId
    || vector.length !== space.dimensions
    || work.payload.distanceMetric !== space.distanceMetric
    || work.payload.dimensions !== space.dimensions
  ) {
    throw new InvalidVectorIndexWorkError("invalid vector projection payload");
  }
  return {
    kind: "upsert",
    record: {
      chunkId: work.chunkId,
      documentId: work.documentId,
      vector,
      version: work.canonicalVersion,
      payload: vectorPayload(work.payload),
    },
  };
};

const vectorPayload = (
  payload: Record<string, unknown>,
): VectorIndexPayload => {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidVectorIndexWorkError("invalid vector metadata payload");
  }
  let normalizedMetadata: VectorIndexPayload["metadata"];
  try {
    normalizedMetadata = normalizeVectorMetadataFilter(
      metadata as Record<string, unknown>,
    ) ?? {};
  } catch {
    throw new InvalidVectorIndexWorkError("invalid vector metadata payload");
  }
  if (typeof payload.retrievalEnabled !== "boolean") {
    throw new InvalidVectorIndexWorkError("invalid vector eligibility payload");
  }
  if (
    payload.sourceId !== null
    && typeof payload.sourceId !== "string"
  ) {
    throw new InvalidVectorIndexWorkError("invalid vector source payload");
  }
  if (
    payload.retrievalExpiresAt !== null
    && typeof payload.retrievalExpiresAt !== "string"
  ) {
    throw new InvalidVectorIndexWorkError("invalid vector expiry payload");
  }
  return {
    sourceId: payload.sourceId,
    metadata: normalizedMetadata,
    retrievalEnabled: payload.retrievalEnabled,
    retrievalExpiresAt: payload.retrievalExpiresAt,
  };
};

const numberArray = (value: unknown): number[] => {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new InvalidVectorIndexWorkError("invalid vector payload");
  }
  return value;
};
