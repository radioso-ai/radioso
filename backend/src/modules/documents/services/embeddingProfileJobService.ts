import { createHash } from "node:crypto";

import type { DocumentProcessingJobRecord } from "../../../db/repositories/documentProcessingJobRepository.js";
import type {
  EmbeddingConsumerResult,
  EmbeddingSpaceRef,
  PinnedDocumentEmbeddingPort,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";

export interface EmbeddingProfileJobChunk {
  readonly id: string;
  readonly chunkIndex: number;
  readonly text: string;
}

export type EmbeddingProfileJobLoadResult =
  | {
      readonly outcome: "ready";
      readonly sourceId: string | null;
      /**
       * Only chunks still missing this target-space representation are returned.
       * An empty list means a prior attempt committed successfully.
       */
      readonly chunks: readonly EmbeddingProfileJobChunk[];
    }
  | {
      readonly outcome:
        | "document_deleted"
        | "stale_revision"
        | "superseded";
    };

export interface EmbeddingProfileJobLoadInput {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly embeddingSpaceId: string;
  readonly expectedWorkspaceProfileGeneration: string;
}

export interface EmbeddingProfileJobCommitInput
extends EmbeddingProfileJobLoadInput {
  readonly canonicalVersion: string;
  readonly space: EmbeddingSpaceRef;
  readonly embeddings: readonly {
    readonly chunkId: string;
    readonly chunkIndex: number;
    readonly contentHash: string;
    readonly embedding: readonly number[];
  }[];
}

export interface EmbeddingProfileJobPersistencePort {
  load(
    input: EmbeddingProfileJobLoadInput,
  ): Promise<EmbeddingProfileJobLoadResult>;
  /**
   * Commits all vectors under the same workspace-generation and document-revision
   * fence. Implementations return a stale outcome without writing any vectors
   * when the pin no longer matches.
   */
  commit(
    input: EmbeddingProfileJobCommitInput,
  ): Promise<"completed" | "deleted" | "stale" | "superseded">;
}

export type EmbeddingProfileJobOutcome =
  | "completed"
  | "deleted"
  | "stale"
  | "superseded";

export type EmbeddingProfileTerminalFailureKind =
  | "retry_exhausted"
  | "contract_invalid"
  | "permanent";

export interface EmbeddingProfileTerminalFailurePort {
  recordFailure(input: {
    jobId: string;
    workspaceId: string;
    embeddingSpaceId: string;
    workspaceProfileGeneration: string;
    failureKind: EmbeddingProfileTerminalFailureKind;
  }): Promise<void>;
}

/**
 * Embedding-only processing deliberately has no document or chunk mutation port.
 * It reads the current canonical revision and commits a separate target-space
 * representation through one generation-fenced persistence operation.
 */
export class EmbeddingProfileJobService {
  constructor(
    private readonly persistence: EmbeddingProfileJobPersistencePort,
    private readonly embeddings: PinnedDocumentEmbeddingPort,
  ) {}

  async process(
    job: DocumentProcessingJobRecord,
  ): Promise<EmbeddingProfileJobOutcome> {
    const pins = requireEmbeddingProfileJobPins(job);
    return traceOperation({
      name: "document.embedding_profile.process",
      attributes: {
        "radioso.workspace_id": job.workspaceId,
        "radioso.document_id": job.documentId,
        "radioso.job_id": job.id,
        "document.revision": job.documentRevision,
        "document.job.kind": job.kind,
        "document.job.attempt_count": job.attemptCount,
      },
      run: async () => {
        const work = await this.persistence.load(pins);
        if (work.outcome !== "ready") {
          return mapLoadOutcome(work.outcome);
        }
        if (work.chunks.length === 0) {
          return "completed";
        }

        const usageItems = work.chunks.map((chunk) => {
          const contentBytes = Buffer.byteLength(chunk.text, "utf8");
          return {
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            contentBytes,
            estimatedTokens: estimateTokensFromBytes(contentBytes),
          };
        });
        const generated = await this.embeddings.embedDocumentChunksForSpace({
          workspaceId: job.workspaceId,
          embeddingSpaceId: pins.embeddingSpaceId,
          texts: work.chunks.map((chunk) => chunk.text),
          sourceId: work.sourceId,
          documentId: job.documentId,
          documentRevision: job.documentRevision,
          jobId: job.id,
          usageItems,
          usageContext: {
            workspaceId: job.workspaceId,
            requestId: job.id,
            surface: "documents",
            operation: "embedding_profile",
            attemptKey: [
              "embedding-profile",
              job.documentId,
              job.documentRevision,
              pins.embeddingSpaceId,
              pins.expectedWorkspaceProfileGeneration,
            ].join(":"),
          },
        });
        assertEmbeddingResult(generated, pins.embeddingSpaceId, work.chunks.length);

        return this.persistence.commit({
          ...pins,
          canonicalVersion: String(job.documentRevision),
          space: generated.space,
          embeddings: work.chunks.map((chunk, index) => ({
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            contentHash: createHash("sha256").update(chunk.text).digest("hex"),
            embedding: [...generated.vectors[index]],
          })),
        });
      },
    });
  }
}

const requireEmbeddingProfileJobPins = (
  job: DocumentProcessingJobRecord,
): EmbeddingProfileJobLoadInput => {
  if (job.kind !== "embedding_profile") {
    throw new Error("Embedding profile processing requires an embedding_profile job");
  }
  if (!job.embeddingSpaceId) {
    throw new Error("Embedding profile job requires an immutable embedding space");
  }
  if (
    !job.workspaceProfileGeneration
    || !/^[1-9]\d*$/.test(job.workspaceProfileGeneration)
  ) {
    throw new Error(
      "Embedding profile job requires a positive workspace profile generation",
    );
  }
  if (!Number.isInteger(job.documentRevision) || job.documentRevision < 1) {
    throw new Error("Embedding profile job requires a positive document revision");
  }
  return {
    jobId: job.id,
    workspaceId: job.workspaceId,
    documentId: job.documentId,
    documentRevision: job.documentRevision,
    embeddingSpaceId: job.embeddingSpaceId,
    expectedWorkspaceProfileGeneration: job.workspaceProfileGeneration,
  };
};

const assertEmbeddingResult = (
  result: EmbeddingConsumerResult,
  expectedSpaceId: string,
  expectedCount: number,
): void => {
  if (result.space.id !== expectedSpaceId) {
    throw new Error(
      `Embedding provider returned space ${result.space.id}, not pinned target ${expectedSpaceId}`,
    );
  }
  if (result.vectors.length !== expectedCount) {
    throw new Error(
      `Embedding provider returned ${result.vectors.length} vectors for ${expectedCount} chunks`,
    );
  }
  for (const vector of result.vectors) {
    if (vector.length !== result.space.dimensions) {
      throw new Error(
        `Embedding dimensions ${vector.length} do not match target space dimensions ${result.space.dimensions}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding provider returned a non-finite vector");
    }
  }
};

const mapLoadOutcome = (
  outcome: Exclude<EmbeddingProfileJobLoadResult["outcome"], "ready">,
): Exclude<EmbeddingProfileJobOutcome, "completed"> => {
  if (outcome === "document_deleted") {
    return "deleted";
  }
  if (outcome === "stale_revision") {
    return "stale";
  }
  return "superseded";
};

const estimateTokensFromBytes = (contentBytes: number): number =>
  Math.max(1, Math.ceil(contentBytes / 4));
